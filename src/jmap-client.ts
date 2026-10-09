/**
 * JMAP Client
 * Implements core JMAP protocol operations per RFC 8620 and RFC 8621
 * Works with any JMAP-compliant email provider
 */

import { UpstreamAuthError } from './upstream-error.js';
import type {
    JMAPSession,
    JMAPRequest,
    JMAPResponse,
    JMAPMethodCall,
    AccountConfig,
    Mailbox,
    Email,
    EmailChanges,
    EmailQuery,
    EmailFilter,
    EmailFilterExpression,
    MaskedEmail,
    MaskedEmailState,
    VacationResponse,
    EmailSort,
    Identity,
    AddressBook,
    ContactCard,
    ContactCardFilter,
} from './types.js';

/**
 * The properties every summary-shaped read asks for.
 *
 * Shared by getEmails and getEmailChanges so the two cannot drift: a field
 * added for search that the change feed did not also request would give a
 * caller the same message with different shapes depending on how it arrived.
 */
const EMAIL_SUMMARY_PROPERTIES = [
    'id', 'blobId', 'threadId', 'mailboxIds', 'keywords',
    'receivedAt', 'from', 'to', 'cc', 'bcc', 'replyTo',
    'subject', 'sentAt', 'hasAttachment', 'preview',
    // Header-derived, and free on this same Email/get -- no extra round trip
    // and no body fetch. Callers need messageId to build a message:// link.
    'messageId', 'inReplyTo', 'references',
    // RFC 8058/2369. Whether a message can be unsubscribed from is the single
    // most useful fact about a newsletter during triage, and without it an
    // agent can only ever propose deleting one -- which does not stop more
    // arriving. Null on ordinary mail, so it costs almost nothing to carry.
    'header:List-Unsubscribe:asURLs',
];

export const JMAP_CAPABILITIES = {
    core: 'urn:ietf:params:jmap:core',
    mail: 'urn:ietf:params:jmap:mail',
    submission: 'urn:ietf:params:jmap:submission',
    contacts: 'urn:ietf:params:jmap:contacts',
    vacation: 'urn:ietf:params:jmap:vacationresponse',
    /** Fastmail's own extension; no RFC, and absent on other providers. */
    maskedEmail: 'https://www.fastmail.com/dev/maskedemail',
};

/**
 * Which capability each JMAP data type belongs to, so a request declares what
 * its own method calls need and nothing else.
 *
 * RFC 8620 4.1: `using` names the capabilities required by the methods in this
 * request. Declaring more is not harmless -- a server that scopes a credential
 * rejects the *whole request* on an unpermitted capability, before any method
 * runs. Sending `submission` on every request therefore made a read-only token
 * fail on `Email/query`, a pure read, with a 403 naming a capability the search
 * never needed.
 *
 * Splits follow RFC 8621: Mailbox/Thread/Email/SearchSnippet are mail, while
 * Identity and EmailSubmission are submission. Contacts are RFC 9610.
 */
const TYPE_CAPABILITIES: Record<string, string> = {
    Mailbox: JMAP_CAPABILITIES.mail,
    Thread: JMAP_CAPABILITIES.mail,
    Email: JMAP_CAPABILITIES.mail,
    SearchSnippet: JMAP_CAPABILITIES.mail,
    Identity: JMAP_CAPABILITIES.submission,
    EmailSubmission: JMAP_CAPABILITIES.submission,
    AddressBook: JMAP_CAPABILITIES.contacts,
    ContactCard: JMAP_CAPABILITIES.contacts,
    Contact: JMAP_CAPABILITIES.contacts,
    ContactGroup: JMAP_CAPABILITIES.contacts,
    VacationResponse: JMAP_CAPABILITIES.vacation,
    MaskedEmail: JMAP_CAPABILITIES.maskedEmail,
};

/**
 * The capability set a batch of method calls actually requires.
 *
 * Core is always present: RFC 8620 defines the request envelope itself. An
 * unrecognised type contributes nothing, so the server answers with
 * `unknownMethod` for that one call rather than refusing the batch.
 */
/** What a missing capability means in the words a user would use. */
const CAPABILITY_LABELS: Record<string, string> = {
    [JMAP_CAPABILITIES.mail]: 'read mail',
    [JMAP_CAPABILITIES.submission]: 'send mail',
    [JMAP_CAPABILITIES.contacts]: 'access contacts',
    [JMAP_CAPABILITIES.vacation]: 'read or change the auto-reply',
    [JMAP_CAPABILITIES.maskedEmail]: 'use masked addresses',
};

export function capabilitiesFor(methodCalls: JMAPMethodCall[]): string[] {
    const using = new Set<string>([JMAP_CAPABILITIES.core]);
    for (const [method] of methodCalls) {
        const capability = TYPE_CAPABILITIES[String(method).split('/')[0]];
        if (capability) using.add(capability);
    }
    return [...using];
}

/**
 * Names callers reach for, mapped to the JMAP role that actually identifies the
 * mailbox (RFC 8621 §2).
 *
 * The visible name of a standard mailbox varies by provider and by locale --
 * Fastmail calls the junk folder "Spam", other providers call trash "Bin" -- and
 * the user can rename any of them. The role does not change, so it is the only
 * dependable way to find these. Aliases are included because a person or a model
 * will ask for "Junk" regardless of what the folder is actually called.
 */
export const WELL_KNOWN_MAILBOX_ROLES: Readonly<Record<string, string>> = {
    inbox: 'inbox',
    sent: 'sent',
    'sent items': 'sent',
    'sent messages': 'sent',
    drafts: 'drafts',
    draft: 'drafts',
    archive: 'archive',
    'all mail': 'archive',
    junk: 'junk',
    spam: 'junk',
    'junk email': 'junk',
    trash: 'trash',
    bin: 'trash',
    deleted: 'trash',
    'deleted items': 'trash',
    'deleted messages': 'trash',
    snoozed: 'snoozed',
    scheduled: 'scheduled',
    templates: 'templates',
};

/** What both a draft and a sent message are built from. */
export interface DraftFields {
    /**
     * Address to send as. Matched against the account's identities; an address
     * that is not one of them is refused rather than silently replaced, since a
     * draft from the wrong identity is only noticed after it is sent.
     */
    from?: string;
    to: string[];
    subject: string;
    textBody: string;
    htmlBody?: string;
    cc?: string[];
    bcc?: string[];
    replyTo?: string;
    inReplyTo?: string;
    references?: string[];
}

/**
 * The JMAP Email object for a draft.
 *
 * Shared by `sendEmail` and `createDraft`, because a sent message *is* a draft
 * that was then submitted -- JMAP creates it in Drafts with `$draft` either way,
 * and sending only adds an EmailSubmission. Building it twice would let the two
 * drift, and the difference would surface as a message that looks right in
 * Drafts and wrong once sent.
 */
/**
 * The identity permitted to send as a given address.
 *
 * Fastmail represents a catch-all domain as a literal wildcard identity --
 * `*@example.com` -- so an exact match alone rejects every address on a domain
 * the user owns. An exact identity wins; otherwise the wildcard for that domain
 * does. An address on a domain with neither is genuinely not sendable, and is
 * refused rather than quietly replaced.
 */
/**
 * A filename safe to place in a URL path segment.
 *
 * Path separators are the only characters that matter: percent-encoded they
 * become %2F or %5C, which servers commonly refuse in a path. Everything else
 * survives encodeURIComponent.
 */
export function safeDownloadName(name: string | undefined): string {
    const cleaned = (name ?? '').replace(/[/\\]+/g, '_').trim();
    return cleaned.length > 0 ? cleaned : 'download';
}

export function matchIdentity<T extends { email: string }>(
    identities: readonly T[],
    from: string
): T | undefined {
    const want = from.trim().toLowerCase();
    const exact = identities.find((i) => i.email.toLowerCase() === want);
    if (exact) return exact;

    const at = want.lastIndexOf('@');
    if (at < 0) return undefined;
    const wildcard = `*${want.slice(at)}`;
    return identities.find((i) => i.email.toLowerCase() === wildcard);
}

export function buildDraftEmail(
    params: DraftFields,
    draftsMailboxId: string,
    identity: { email: string; name?: string | null },
    /**
     * The address to put in From. Differs from the identity's own email when a
     * wildcard identity authorises it -- writing `*@example.com` into a header
     * would produce an unsendable message.
     */
    fromAddress?: string
): Record<string, unknown> {
    const email: Record<string, unknown> = {
        mailboxIds: { [draftsMailboxId]: true },
        from: [{ email: fromAddress ?? identity.email, name: identity.name || null }],
        to: params.to.map((address) => ({ email: address, name: null })),
        subject: params.subject,
        textBody: [{ partId: 'text', type: 'text/plain' }],
        bodyValues: {
            text: { value: params.textBody, isEncodingProblem: false, isTruncated: false },
        },
        keywords: { $draft: true },
    };

    if (params.cc && params.cc.length > 0) {
        email.cc = params.cc.map((address) => ({ email: address, name: null }));
    }
    if (params.bcc && params.bcc.length > 0) {
        email.bcc = params.bcc.map((address) => ({ email: address, name: null }));
    }
    if (params.replyTo) {
        email.replyTo = [{ email: params.replyTo, name: null }];
    }
    if (params.htmlBody) {
        email.htmlBody = [{ partId: 'html', type: 'text/html' }];
        (email.bodyValues as Record<string, unknown>).html = {
            value: params.htmlBody,
            isEncodingProblem: false,
            isTruncated: false,
        };
    }
    // Threading. Without these a reply opens a new conversation -- which looks
    // correct in a Drafts list and wrong in every client that threads.
    if (params.inReplyTo) {
        email.inReplyTo = [params.inReplyTo];
    }
    if (params.references && params.references.length > 0) {
        email.references = params.references;
    }

    return email;
}

export class JMAPClient {
    private session: JMAPSession | null = null;
    private accountId: string | null = null;
    private config: AccountConfig;

    constructor(config: AccountConfig) {
        if (!config.sessionUrl) {
            throw new Error('sessionUrl is required in AccountConfig');
        }
        this.config = config;
    }

    /**
     * Fetch the JMAP session to get account info and API URLs
     */
    async fetchSession(): Promise<JMAPSession> {
        const response = await fetch(this.config.sessionUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.config.token}`,
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            // A refused credential is raised as its own type so a consumer can
            // tell it from a bad argument without reading prose. Everything
            // else stays an ordinary Error.
            if (response.status === 401 || response.status === 403) {
                throw new UpstreamAuthError(
                    `The mail provider rejected this account's API token: ${response.status} ${response.statusText} - ${errorText}`,
                    { status: response.status, service: 'jmap' }
                );
            }
            throw new Error(`Failed to fetch JMAP session: ${response.status} ${response.statusText} - ${errorText}`);
        }

        this.session = await response.json() as JMAPSession;

        // Get the primary mail account ID
        const mailAccountId = this.session.primaryAccounts[JMAP_CAPABILITIES.mail];
        if (!mailAccountId) {
            throw new Error('No mail account found in JMAP session');
        }
        this.accountId = mailAccountId;

        return this.session;
    }

    /**
     * Ensure we have a valid session
     */
    private async ensureSession(): Promise<void> {
        if (!this.session || !this.accountId) {
            await this.fetchSession();
        }
    }

    /**
     * Make a JMAP API request
     */
    /**
     * The capability URIs this credential may actually use.
     *
     * Fastmail scopes the session's capability set to the token: a read-only
     * token advertises mail without submission, and a mail-only token omits
     * contacts entirely. Verified against two live tokens, both of which list
     * exactly core, mail and submission.
     */
    async getCapabilities(): Promise<Set<string>> {
        await this.ensureSession();
        return new Set(Object.keys(this.session?.capabilities ?? {}));
    }

    async hasCapability(capability: string): Promise<boolean> {
        return (await this.getCapabilities()).has(capability);
    }

    async request(methodCalls: JMAPMethodCall[]): Promise<JMAPResponse> {
        await this.ensureSession();

        const using = capabilitiesFor(methodCalls);

        // Refuse locally rather than spend a round trip earning a 403. Only an
        // explicitly absent capability blocks: a server that advertises its
        // capabilities server-wide rather than per-credential will list it and
        // we behave exactly as before, letting the server decide.
        const available = new Set(Object.keys(this.session?.capabilities ?? {}));
        const missing = using.filter((capability) => !available.has(capability));
        if (missing.length > 0) {
            const wanted = missing
                .map((capability) => CAPABILITY_LABELS[capability] ?? capability)
                .join(' and ');
            throw new Error(
                `This account's credentials cannot ${wanted}. ` +
                    `The server did not grant ${missing.join(', ')} for this token, ` +
                    `so ${methodCalls.map(([method]) => method).join(', ')} cannot run. ` +
                    `Use a token with the required scope, or an operation that does not need it.`
            );
        }

        const request: JMAPRequest = {
            using,
            methodCalls,
        };

        const response = await fetch(this.session!.apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(request),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`JMAP request failed: ${response.status} ${response.statusText} - ${errorText}`);
        }

        return await response.json() as JMAPResponse;
    }

    /**
     * Get account ID
     */
    getAccountId(): string {
        if (!this.accountId) {
            throw new Error('Session not initialized. Call fetchSession() first.');
        }
        return this.accountId;
    }

    /**
     * Get session username (email)
     */
    getUsername(): string {
        if (!this.session) {
            throw new Error('Session not initialized. Call fetchSession() first.');
        }
        return this.session.username;
    }

    // ==========================================================================
    // Mailbox Operations
    // ==========================================================================

    /**
     * Get all mailboxes
     */
    async getMailboxes(): Promise<Mailbox[]> {
        await this.ensureSession();

        const response = await this.request([
            ['Mailbox/get', { accountId: this.accountId, ids: null }, 'a'],
        ]);

        const [name, result] = response.methodResponses[0];
        if (name === 'error') {
            throw new Error(`Mailbox/get failed: ${JSON.stringify(result)}`);
        }

        return (result as { list: Mailbox[] }).list;
    }

    /**
     * Find mailbox by role (e.g., 'inbox', 'trash', 'sent', 'drafts')
     */
    async getMailboxByRole(role: string): Promise<Mailbox | null> {
        const mailboxes = await this.getMailboxes();
        return mailboxes.find(m => m.role === role) || null;
    }

    /**
     * Find mailbox by name
     */
    async getMailboxByName(name: string): Promise<Mailbox | null> {
        const mailboxes = await this.getMailboxes();
        return mailboxes.find(m => m.name.toLowerCase() === name.toLowerCase()) || null;
    }

    /**
     * Builds the full path of a mailbox, e.g. `migrated/Junk`.
     *
     * Names are only unique among siblings, so the leaf name alone cannot
     * distinguish two folders called Junk in different parents.
     */
    private mailboxPath(mailbox: Mailbox, byId: Map<string, Mailbox>): string {
        const segments = [mailbox.name];
        const seen = new Set([mailbox.id]);
        let parentId = mailbox.parentId;
        // `seen` guards against a cycle in parentId, which would otherwise hang
        // the caller rather than return a wrong answer.
        while (parentId && !seen.has(parentId)) {
            const parent = byId.get(parentId);
            if (!parent) break;
            segments.unshift(parent.name);
            seen.add(parent.id);
            parentId = parent.parentId;
        }
        return segments.join('/');
    }

    /**
     * Find a mailbox by ID, well-known name, path or name.
     *
     * Resolution order matters, and role has to come before name. A mailbox's
     * *role* is what makes it the junk folder; its name is a label the user can
     * change, and providers localise it -- Fastmail names the junk folder
     * "Spam". Matching on name first meant "Junk" could not find it at all, and
     * instead matched an empty `migrated/Junk` left behind by an IMAP import.
     * The response was well formed and the count was zero, so nothing indicated
     * that the folder searched was not the folder meant.
     *
     * Name-first was fragile even where it worked: "Sent", "Archive", "Drafts"
     * and "Inbox" all had shadows in that same import, and resolved correctly
     * only because the real folder happened to come first in the array. One of
     * those shadows held more mail than the folder it shadowed.
     *
     * Path is tried before the bare name so a shadowed folder stays reachable
     * -- `migrated/Junk` still resolves to exactly itself.
     */
    async resolveMailbox(idOrName: string): Promise<Mailbox | null> {
        const mailboxes = await this.getMailboxes();

        const byId = mailboxes.find(m => m.id === idOrName);
        if (byId) return byId;

        const query = idOrName.trim().toLowerCase();
        if (!query) return null;

        const role = WELL_KNOWN_MAILBOX_ROLES[query];
        if (role) {
            const byRole = mailboxes.find(m => m.role === role);
            if (byRole) return byRole;
        }

        const idIndex = new Map(mailboxes.map(m => [m.id, m]));
        const byPath = mailboxes.find(
            m => this.mailboxPath(m, idIndex).toLowerCase() === query
        );
        if (byPath) return byPath;

        // Fall back to the leaf name. Where several siblings-by-name collide,
        // prefer one that carries a role: it is the real folder, and the
        // duplicate is almost always an import artefact.
        const byName = mailboxes.filter(m => m.name.toLowerCase() === query);
        return byName.find(m => m.role !== null) ?? byName[0] ?? null;
    }

    // ==========================================================================
    // Email Query Operations
    // ==========================================================================

    /**
     * Query emails with filters
     */
    async queryEmails(filter?: EmailFilterExpression, sort?: EmailSort[], limit = 50): Promise<string[]> {
        const { ids } = await this.queryEmailsPage(filter, sort, { limit });
        return ids;
    }

    /**
     * One page of a query, with the figures needed to know there is another.
     *
     * `queryEmails` returns bare ids, which cannot express "there were 49
     * matches and you are holding 20 of them". The count was never expensive to
     * obtain -- `calculateTotal` has always been set on this query and the
     * answer was simply discarded -- so a caller that could not tell a complete
     * result from a truncated one was paying for the information and then
     * throwing it away.
     */
    async queryEmailsPage(
        filter?: EmailFilterExpression,
        sort?: EmailSort[],
        options: { limit?: number; position?: number } = {}
    ): Promise<{ ids: string[]; total: number; position: number }> {
        await this.ensureSession();

        const limit = options.limit ?? 50;
        // A negative position is relative to the end of the result set in JMAP,
        // which would silently return a different page than a caller expecting
        // an offset intends.
        const position = Math.max(0, Math.trunc(options.position ?? 0));

        const query: EmailQuery = {
            accountId: this.accountId!,
            filter,
            sort: sort || [{ property: 'receivedAt', isAscending: false }],
            limit,
            position,
            calculateTotal: true,
        };

        const response = await this.request([
            ['Email/query', query as unknown as Record<string, unknown>, 'a'],
        ]);

        const [name, result] = response.methodResponses[0];
        if (name === 'error') {
            throw new Error(`Email/query failed: ${JSON.stringify(result)}`);
        }

        const page = result as { ids: string[]; total?: number; position?: number };
        return {
            ids: page.ids,
            // calculateTotal is a MAY in RFC 8620: a server is permitted to omit
            // it. Falling back to what we can see beats reporting zero, which a
            // caller would read as "no matches".
            total: page.total ?? position + page.ids.length,
            position: page.position ?? position,
        };
    }

    /**
     * The current Email state, with no changes.
     *
     * Bootstrapping must be an explicit act. A delta call given no prior state
     * could plausibly return the whole mailbox instead, which is the kind of
     * thing that looks like it worked -- so a caller with no state gets a
     * starting point and nothing else, and fetches history by other means.
     */
    async getEmailState(): Promise<string> {
        await this.ensureSession();

        const response = await this.request([
            ['Email/get', { accountId: this.accountId, ids: [] }, 'a'],
        ]);

        const [name, result] = response.methodResponses[0];
        if (name === 'error') {
            throw new Error(`Email/get failed: ${JSON.stringify(result)}`);
        }
        return (result as { state: string }).state;
    }

    /**
     * What changed since a previous Email state.
     *
     * One HTTP request. Email/changes names the ids and two Email/get calls
     * back-reference them (RFC 8620 3.7), so created and updated arrive fully
     * populated without a second round trip. The alternative -- query then get,
     * per filter -- is what makes a polling consumer expensive.
     *
     * Scope is account-wide: RFC 8620 defines /changes per data type per
     * account, with no mailbox filter. Sent is therefore included for free, and
     * a caller wanting a narrower view filters on the returned mailboxIds.
     */
    async getEmailChanges(
        sinceState: string,
        options: { maxChanges?: number; properties?: string[] } = {}
    ): Promise<EmailChanges> {
        await this.ensureSession();

        const maxChanges = Math.max(1, Math.trunc(options.maxChanges ?? 128));
        const properties = options.properties ?? EMAIL_SUMMARY_PROPERTIES;
        const ref = (path: string) => ({
            resultOf: 'c',
            name: 'Email/changes',
            path,
        });

        const response = await this.request([
            ['Email/changes', { accountId: this.accountId, sinceState, maxChanges }, 'c'],
            ['Email/get', { accountId: this.accountId, '#ids': ref('/created'), properties }, 'gc'],
            ['Email/get', { accountId: this.accountId, '#ids': ref('/updated'), properties }, 'gu'],
        ]);

        const [changesName, changesResult] = response.methodResponses[0];
        if (changesName === 'error') {
            const error = changesResult as { type?: string };
            // The one failure a caller must never mistake for "nothing changed".
            // The server can no longer reconstruct the delta from the state
            // given, so the only correct response is a full resync -- and a
            // silent empty list here would freeze a cache while looking healthy.
            if (error.type === 'cannotCalculateChanges') {
                throw new Error(
                    'cannotCalculateChanges: the server can no longer compute changes since that state. ' +
                        'It is too old or was invalidated. Discard the stored state and perform a full resync; ' +
                        'do not treat this as an empty result.'
                );
            }
            throw new Error(`Email/changes failed: ${JSON.stringify(changesResult)}`);
        }

        const changes = changesResult as {
            newState: string;
            hasMoreChanges: boolean;
            created: string[];
            updated: string[];
            destroyed: string[];
        };

        const listFrom = (index: number): Email[] => {
            const [name, result] = response.methodResponses[index];
            // A failed Email/get must not be reported as "no messages changed".
            if (name === 'error') throw new Error(`Email/get failed: ${JSON.stringify(result)}`);
            return (result as { list: Email[] }).list;
        };

        return {
            newState: changes.newState,
            hasMoreChanges: changes.hasMoreChanges === true,
            created: listFrom(1),
            updated: listFrom(2),
            destroyedIds: changes.destroyed ?? [],
        };
    }

    /**
     * Get emails by ID with specified properties
     */
    /**
     * Fetches several messages WITH their bodies, in one request.
     *
     * getEmailWithBody handles one message, so reading a shortlist of twenty
     * cost twenty round trips. A consumer measured 0.38s per message and
     * reported a 79-message backfill at 30s -- longer than its entire
     * eleven-query search of ten thousand messages.
     */
    async getEmailsWithBodies(ids: string[]): Promise<Email[]> {
        if (ids.length === 0) return [];
        await this.ensureSession();

        const response = await this.request([
            ['Email/get', {
                accountId: this.accountId,
                ids,
                properties: [
                    ...EMAIL_SUMMARY_PROPERTIES,
                    'bodyStructure',
                    'bodyValues',
                    'textBody',
                    'htmlBody',
                    'attachments',
                ],
                fetchAllBodyValues: true,
            }, 'a'],
        ]);

        const [name, result] = response.methodResponses[0];
        if (name === 'error') {
            throw new Error(`Email/get failed: ${JSON.stringify(result)}`);
        }

        return (result as { list: Email[] }).list;
    }

    async getEmails(ids: string[], properties?: string[]): Promise<Email[]> {
        await this.ensureSession();

        if (ids.length === 0) {
            return [];
        }

        // messageId/inReplyTo/references are header-derived properties returned by
        // this same Email/get -- they cost no extra round trip and no body fetch.
        // Callers need messageId to build an RFC 5322 `message://` link that opens
        // a desktop mail client; the JMAP id only addresses the web app.


        const response = await this.request([
            ['Email/get', {
                accountId: this.accountId,
                ids,
                properties: properties || EMAIL_SUMMARY_PROPERTIES,
            }, 'a'],
        ]);

        const [name, result] = response.methodResponses[0];
        if (name === 'error') {
            throw new Error(`Email/get failed: ${JSON.stringify(result)}`);
        }

        return (result as { list: Email[] }).list;
    }

    /**
     * Get full email content including body
     */
    async getEmailWithBody(id: string): Promise<Email> {
        await this.ensureSession();

        const response = await this.request([
            ['Email/get', {
                accountId: this.accountId,
                ids: [id],
                properties: [
                    'id', 'blobId', 'threadId', 'mailboxIds', 'keywords',
                    'receivedAt', 'from', 'to', 'cc', 'bcc', 'replyTo',
                    'subject', 'sentAt', 'hasAttachment', 'preview',
                    'messageId', 'inReplyTo', 'references',
                    'bodyStructure', 'bodyValues', 'textBody', 'htmlBody', 'attachments',
                ],
                fetchAllBodyValues: true,
            }, 'a'],
        ]);

        const [name, result] = response.methodResponses[0];
        if (name === 'error') {
            throw new Error(`Email/get failed: ${JSON.stringify(result)}`);
        }

        const emails = (result as { list: Email[] }).list;
        if (emails.length === 0) {
            throw new Error(`Email not found: ${id}`);
        }

        return emails[0];
    }

    // ==========================================================================
    // Email Modification Operations
    // ==========================================================================

    /**
     * Update email properties (mailboxIds, keywords)
     */
    async updateEmails(updates: Record<string, Record<string, unknown>>): Promise<void> {
        const outcome = await this.updateEmailsDetailed(updates);
        const failed = Object.keys(outcome.notUpdated);
        if (failed.length > 0) {
            throw new Error(`Failed to update some emails: ${JSON.stringify(outcome.notUpdated)}`);
        }
    }

    /**
     * Updates emails and reports what happened to each one.
     *
     * JMAP applies an Email/set per id, so a batch can half succeed. The
     * throwing wrapper above turns that into a single failure, which loses the
     * fact that most of the batch went through -- a caller told "failed" after
     * 97 of 100 messages moved has been misinformed in a way it cannot detect.
     * Callers that can report per message should use this instead.
     */
    async updateEmailsDetailed(
        updates: Record<string, Record<string, unknown>>
    ): Promise<{
        updated: string[];
        notUpdated: Record<string, { type: string; description?: string }>;
    }> {
        await this.ensureSession();

        const response = await this.request([
            ['Email/set', {
                accountId: this.accountId,
                update: updates,
            }, 'a'],
        ]);

        const [name, result] = response.methodResponses[0];
        if (name === 'error') {
            throw new Error(`Email/set failed: ${JSON.stringify(result)}`);
        }

        const setResult = result as {
            updated?: Record<string, unknown> | null;
            notUpdated?: Record<string, { type: string; description?: string }>;
        };
        const notUpdated = setResult.notUpdated ?? {};
        // `updated` carries only ids the server chose to echo, so membership is
        // derived from the request minus the explicit failures rather than read
        // from it -- a server that returns `updated: null` on full success
        // would otherwise look like a total failure.
        const updated = Object.keys(updates).filter((id) => !(id in notUpdated));

        return { updated, notUpdated };
    }

    /**
     * Move emails to a mailbox
     */
    async moveEmails(emailIds: string[], mailboxId: string): Promise<void> {
        const updates: Record<string, Record<string, unknown>> = {};
        for (const id of emailIds) {
            updates[id] = {
                mailboxIds: { [mailboxId]: true },
            };
        }
        await this.updateEmails(updates);
    }

    /**
     * Delete emails (move to trash)
     */
    async deleteEmails(emailIds: string[]): Promise<void> {
        const trash = await this.getMailboxByRole('trash');
        if (!trash) {
            throw new Error('Trash mailbox not found');
        }
        await this.moveEmails(emailIds, trash.id);
    }

    /**
     * Set email keywords (read, flagged, etc.)
     */
    async setEmailKeywords(
        emailIds: string[],
        addKeywords?: string[],
        removeKeywords?: string[]
    ): Promise<void> {
        const updates: Record<string, Record<string, unknown>> = {};

        for (const id of emailIds) {
            const keywordUpdates: Record<string, unknown> = {};

            if (addKeywords) {
                for (const keyword of addKeywords) {
                    keywordUpdates[`keywords/${keyword}`] = true;
                }
            }

            if (removeKeywords) {
                for (const keyword of removeKeywords) {
                    keywordUpdates[`keywords/${keyword}`] = null;
                }
            }

            updates[id] = keywordUpdates;
        }

        await this.updateEmails(updates);
    }

    /**
     * Mark emails as read/unread
     */
    async markEmailsRead(emailIds: string[], isRead: boolean): Promise<void> {
        if (isRead) {
            await this.setEmailKeywords(emailIds, ['$seen'], undefined);
        } else {
            await this.setEmailKeywords(emailIds, undefined, ['$seen']);
        }
    }

    /**
     * Mark emails as flagged/unflagged
     */
    async markEmailsFlagged(emailIds: string[], isFlagged: boolean): Promise<void> {
        if (isFlagged) {
            await this.setEmailKeywords(emailIds, ['$flagged'], undefined);
        } else {
            await this.setEmailKeywords(emailIds, undefined, ['$flagged']);
        }
    }

    // ==========================================================================
    // Email Creation and Submission
    // ==========================================================================

    /**
     * Get identities (sender addresses)
     */
    async getIdentities(): Promise<Identity[]> {
        await this.ensureSession();

        const response = await this.request([
            ['Identity/get', { accountId: this.accountId, ids: null }, 'a'],
        ]);

        const [name, result] = response.methodResponses[0];
        if (name === 'error') {
            throw new Error(`Identity/get failed: ${JSON.stringify(result)}`);
        }

        return (result as { list: Identity[] }).list;
    }

    /**
     * Every message in a conversation, oldest first.
     *
     * Following a thread previously cost one call per message, and the caller
     * had to reassemble the order itself. Thread/get names the members and a
     * back-referenced Email/get fetches them, so this is one round trip.
     */
    async getThread(
        threadId: string,
        options: { properties?: string[]; withBodies?: boolean } = {}
    ): Promise<Email[]> {
        await this.ensureSession();

        const properties = options.properties ?? [
            ...EMAIL_SUMMARY_PROPERTIES,
            ...(options.withBodies ? ['bodyStructure', 'bodyValues', 'textBody', 'htmlBody', 'attachments'] : []),
        ];

        const response = await this.request([
            ['Thread/get', { accountId: this.accountId, ids: [threadId] }, 't'],
            ['Email/get', {
                accountId: this.accountId,
                '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' },
                properties,
                ...(options.withBodies ? { fetchAllBodyValues: true } : {}),
            }, 'e'],
        ]);

        const [threadName, threadResult] = response.methodResponses[0];
        if (threadName === 'error') {
            throw new Error(`Thread/get failed: ${JSON.stringify(threadResult)}`);
        }
        // A thread id that matches nothing is not an empty conversation.
        const list = (threadResult as { list: { id: string }[] }).list;
        if (!list || list.length === 0) {
            throw new Error(`No thread with id "${threadId}".`);
        }

        const [emailName, emailResult] = response.methodResponses[1];
        if (emailName === 'error') {
            throw new Error(`Email/get failed: ${JSON.stringify(emailResult)}`);
        }

        // Thread order is by receivedAt; JMAP does not promise the get preserves it.
        return [...(emailResult as { list: Email[] }).list].sort((a, b) =>
            (a.receivedAt ?? '').localeCompare(b.receivedAt ?? '')
        );
    }

    /**
     * Download one blob — an attachment's bytes.
     *
     * The session's downloadUrl is a URI template (RFC 6570) with accountId,
     * blobId, type and name placeholders. Substituting by hand rather than
     * assuming a fixed shape, because providers differ in where they put them.
     */
    async downloadBlob(
        blobId: string,
        options: { type?: string; name?: string; maxBytes?: number } = {}
    ): Promise<{ bytes: Buffer; contentType: string; truncated: boolean }> {
        await this.ensureSession();

        const template = this.session!.downloadUrl;
        const url = template
            .replace('{accountId}', encodeURIComponent(this.accountId!))
            .replace('{blobId}', encodeURIComponent(blobId))
            .replace('{type}', encodeURIComponent(options.type ?? 'application/octet-stream'))
            // The name is a download-filename hint that sits in the URL *path*,
            // so a separator in it survives encoding as %2F and many servers
            // reject that outright. Observed: six Third Bridge remittance PDFs
            // named "Bill Payment_00006163/172.pdf" all 404'd, while the same
            // blob fetched with the separator replaced returned 48774 bytes.
            // Nothing identifies the blob by name, so rewriting it is free.
            .replace('{name}', encodeURIComponent(safeDownloadName(options.name)));

        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${this.config.token}` },
        });
        if (!response.ok) {
            throw new Error(`Blob download failed: ${response.status} ${response.statusText}`);
        }

        const full = Buffer.from(await response.arrayBuffer());
        const max = options.maxBytes;
        const truncated = max !== undefined && full.byteLength > max;

        return {
            bytes: truncated ? full.subarray(0, max) : full,
            contentType: response.headers.get('content-type') ?? 'application/octet-stream',
            truncated,
        };
    }

    /**
     * Create a draft without sending it.
     *
     * Identical to `sendEmail` minus the EmailSubmission: JMAP already creates a
     * draft in the Drafts mailbox with `$draft` as the first half of sending, so
     * this is that half on its own.
     *
     * The caller gets a message they can read and edit before anyone else sees
     * it, which is the whole point -- sending is not a smaller version of
     * drafting.
     */
    async createDraft(
        params: DraftFields
    ): Promise<{ emailId: string; mailboxId: string; from: string; sendable: boolean }> {
        await this.ensureSession();

        const identities = await this.getIdentities();
        if (identities.length === 0) {
            throw new Error('No sending identity found');
        }

        // A requested identity must exist. Falling back to the default would
        // produce a draft from the wrong address, which is the kind of mistake
        // nobody notices until after it has been sent.
        // A draft is not a submission, and Fastmail stores any From on one --
        // verified. Refusing here would be a limiter this client invented, and
        // it would block exactly the ad-hoc per-correspondent addresses a
        // catch-all domain exists for.
        //
        // So: never refuse, but say whether the address is actually sendable.
        // A draft that cannot be sent is worth knowing about now rather than at
        // the moment of sending.
        const matched = params.from ? matchIdentity(identities, params.from) : identities[0];
        const identity = matched ?? { email: params.from!, name: null };

        // Drafts only. sendEmail falls back to Inbox because the message is
        // leaving immediately; a draft that silently landed in the Inbox would
        // be lost rather than merely misfiled.
        const drafts = await this.getMailboxByRole('drafts');
        if (!drafts) {
            throw new Error(
                'No Drafts mailbox found on this account, so there is nowhere to put a draft.'
            );
        }

        const response = await this.request([
            ['Email/set', {
                accountId: this.accountId,
                create: { draft: buildDraftEmail(params, drafts.id, identity, params.from) },
            }, 'a'],
        ]);

        const [name, result] = response.methodResponses[0];
        if (name === 'error') {
            throw new Error(`Email/set failed: ${JSON.stringify(result)}`);
        }

        const setResult = result as {
            created?: Record<string, { id: string }>;
            notCreated?: Record<string, unknown>;
        };
        if (setResult.notCreated) {
            throw new Error(`Failed to create draft: ${JSON.stringify(setResult.notCreated)}`);
        }
        const emailId = setResult.created?.draft?.id;
        if (!emailId) {
            // A create that reports neither success nor failure must not be
            // reported as a success with an empty id.
            throw new Error('Draft creation returned no id and no error');
        }

        return {
            emailId,
            mailboxId: drafts.id,
            from: params.from ?? identity.email,
            // False when no identity authorises this From: the draft exists and is
            // editable, but submitting it will be refused by the server.
            sendable: Boolean(matched),
        };
    }

    /**
     * Create and send an email
     */
    async sendEmail(params: {
        to: string[];
        subject: string;
        textBody: string;
        htmlBody?: string;
        cc?: string[];
        bcc?: string[];
        replyTo?: string;
        inReplyTo?: string;
        references?: string[];
    }): Promise<{ emailId: string; submissionId: string }> {
        await this.ensureSession();

        // Get the first identity for sending
        const identities = await this.getIdentities();
        if (identities.length === 0) {
            throw new Error('No sending identity found');
        }
        const identity = identities[0];

        // Get drafts mailbox
        const drafts = await this.getMailboxByRole('drafts') || await this.getMailboxByRole('inbox');
        if (!drafts) {
            throw new Error('No drafts or inbox mailbox found');
        }

        const emailCreate = buildDraftEmail(params, drafts.id, identity);

        const response = await this.request([
            ['Email/set', {
                accountId: this.accountId,
                create: { draft: emailCreate },
            }, 'a'],
            ['EmailSubmission/set', {
                accountId: this.accountId,
                create: {
                    submission: {
                        identityId: identity.id,
                        emailId: '#draft',
                    },
                },
                onSuccessUpdateEmail: {
                    '#submission': {
                        'mailboxIds': null, // Let server move to Sent
                        'keywords/$draft': null,
                        'keywords/$seen': true,
                    },
                },
            }, 'b'],
        ]);

        // Check for errors
        for (const [name, result] of response.methodResponses) {
            if (name === 'error') {
                throw new Error(`Send email failed: ${JSON.stringify(result)}`);
            }
        }

        // Extract IDs from response
        const emailSetResult = response.methodResponses[0][1] as {
            created?: Record<string, { id: string }>;
            notCreated?: Record<string, { type: string; description?: string }>;
        };

        if (emailSetResult.notCreated) {
            throw new Error(`Failed to create email: ${JSON.stringify(emailSetResult.notCreated)}`);
        }

        const submissionSetResult = response.methodResponses[1][1] as {
            created?: Record<string, { id: string }>;
            notCreated?: Record<string, { type: string; description?: string }>;
        };

        if (submissionSetResult.notCreated) {
            throw new Error(`Failed to submit email: ${JSON.stringify(submissionSetResult.notCreated)}`);
        }

        return {
            emailId: emailSetResult.created?.draft?.id || '',
            submissionId: submissionSetResult.created?.submission?.id || '',
        };
    }

    /**
     * The account's auto-reply settings.
     *
     * A singleton with the id "singleton" (RFC 8621 section 8), so this is a
     * get of one known object rather than a query.
     */
    async getVacationResponse(): Promise<VacationResponse> {
        await this.ensureSession();
        const accountId =
            this.session!.primaryAccounts[JMAP_CAPABILITIES.vacation] || this.accountId!;

        const response = await this.request(
[['VacationResponse/get', { accountId, ids: ['singleton'] }, 'v']]);

        const [name, result] = response.methodResponses[0];
        if (name === 'error') {
            throw new Error(`VacationResponse/get failed: ${JSON.stringify(result)}`);
        }

        const list = (result as { list: VacationResponse[] }).list;
        if (!list?.length) {
            throw new Error('The server returned no vacation response settings.');
        }
        return list[0];
    }

    /** Patches the auto-reply. Only the named properties change. */
    async setVacationResponse(patch: Partial<VacationResponse>): Promise<VacationResponse> {
        await this.ensureSession();
        const accountId =
            this.session!.primaryAccounts[JMAP_CAPABILITIES.vacation] || this.accountId!;

        const response = await this.request(
[['VacationResponse/set', { accountId, update: { singleton: patch } }, 'v']]);

        const [name, result] = response.methodResponses[0];
        if (name === 'error') {
            throw new Error(`VacationResponse/set failed: ${JSON.stringify(result)}`);
        }

        const setResult = result as {
            notUpdated?: Record<string, { type: string; description?: string }>;
        };
        if (setResult.notUpdated && Object.keys(setResult.notUpdated).length > 0) {
            throw new Error(
                `The server refused the change: ${JSON.stringify(setResult.notUpdated)}`
            );
        }

        // Read back rather than echo the patch: the server fills in defaults and
        // may normalise dates, and reporting what was asked for instead of what
        // is now stored is how a setting comes to look applied when it is not.
        return this.getVacationResponse();
    }

    /** Every masked address on the account. Fastmail extension; get-only, no query. */
    async getMaskedEmails(): Promise<MaskedEmail[]> {
        await this.ensureSession();
        const accountId =
            this.session!.primaryAccounts[JMAP_CAPABILITIES.maskedEmail] || this.accountId!;

        const response = await this.request(
[['MaskedEmail/get', { accountId, ids: null }, 'm']]);

        const [name, result] = response.methodResponses[0];
        if (name === 'error') {
            throw new Error(`MaskedEmail/get failed: ${JSON.stringify(result)}`);
        }
        return (result as { list: MaskedEmail[] }).list ?? [];
    }

    async createMaskedEmail(params: {
        forDomain?: string;
        description?: string;
        state?: MaskedEmailState;
        emailPrefix?: string;
    }): Promise<MaskedEmail> {
        await this.ensureSession();
        const accountId =
            this.session!.primaryAccounts[JMAP_CAPABILITIES.maskedEmail] || this.accountId!;

        const response = await this.request(
[['MaskedEmail/set', { accountId, create: { new: params } }, 'm']]);

        const [name, result] = response.methodResponses[0];
        if (name === 'error') {
            throw new Error(`MaskedEmail/set failed: ${JSON.stringify(result)}`);
        }

        const setResult = result as {
            created?: Record<string, MaskedEmail>;
            notCreated?: Record<string, { type: string; description?: string }>;
        };
        if (setResult.notCreated && Object.keys(setResult.notCreated).length > 0) {
            throw new Error(`Failed to create a masked address: ${JSON.stringify(setResult.notCreated)}`);
        }

        const created = setResult.created?.new;
        if (!created?.email) {
            // An address that was maybe created, with no address returned, is
            // worse than a failure: nothing downstream can use it and nothing
            // can tell whether it exists.
            throw new Error('The server accepted the request but returned no masked address.');
        }
        return created;
    }

    async updateMaskedEmail(
        id: string,
        patch: { state?: MaskedEmailState; description?: string; forDomain?: string }
    ): Promise<void> {
        await this.ensureSession();
        const accountId =
            this.session!.primaryAccounts[JMAP_CAPABILITIES.maskedEmail] || this.accountId!;

        const response = await this.request(
[['MaskedEmail/set', { accountId, update: { [id]: patch } }, 'm']]);

        const [name, result] = response.methodResponses[0];
        if (name === 'error') {
            throw new Error(`MaskedEmail/set failed: ${JSON.stringify(result)}`);
        }

        const setResult = result as {
            notUpdated?: Record<string, { type: string; description?: string }>;
        };
        if (setResult.notUpdated && Object.keys(setResult.notUpdated).length > 0) {
            throw new Error(`The server refused the change: ${JSON.stringify(setResult.notUpdated)}`);
        }
    }

    /**
     * Submits an existing draft, unchanged.
     *
     * The distinction from sendEmail is the whole point: that one composes and
     * sends in a single step, so there is no artefact a person can read before
     * anything is irreversible. This one sends exactly the message that is
     * already sitting in Drafts -- the one a human reviewed, with the
     * recipients, attachments and threading it already has.
     *
     * The identity is chosen by matching the draft's own From address rather
     * than taking the account's first identity. Sending a reply from the wrong
     * address is a mistake only the recipient notices.
     */
    async sendDraft(emailId: string): Promise<{ emailId: string; submissionId: string }> {
        await this.ensureSession();

        const [email] = await this.getEmails([emailId]);
        if (!email) {
            throw new Error(`No message with id ${emailId}`);
        }

        const drafts = await this.getMailboxByRole('drafts');
        if (!drafts || email.mailboxIds?.[drafts.id] !== true) {
            throw new Error(
                `${emailId} is not in Drafts. Only a draft can be submitted; a message that has already been sent cannot be sent again.`
            );
        }

        const identities = await this.getIdentities();
        const fromAddress = email.from?.[0]?.email;
        const identity = fromAddress ? matchIdentity(identities, fromAddress) : identities[0];
        if (!identity) {
            throw new Error(
                fromAddress
                    ? `No identity on this account authorises sending as "${fromAddress}", so this draft cannot be submitted. Change its From address with update_draft.`
                    : 'This draft has no From address and no identity could be chosen for it.'
            );
        }

        const response = await this.request([
            ['EmailSubmission/set', {
                accountId: this.accountId,
                create: {
                    submission: { identityId: identity.id, emailId },
                },
                onSuccessUpdateEmail: {
                    '#submission': {
                        mailboxIds: null, // Let the server file it in Sent.
                        'keywords/$draft': null,
                        'keywords/$seen': true,
                    },
                },
            }, 'a'],
        ]);

        const [name, result] = response.methodResponses[0];
        if (name === 'error') {
            throw new Error(`Submission failed: ${JSON.stringify(result)}`);
        }

        const setResult = result as {
            created?: Record<string, { id: string }>;
            notCreated?: Record<string, { type: string; description?: string }>;
        };
        if (setResult.notCreated && Object.keys(setResult.notCreated).length > 0) {
            throw new Error(`Failed to send draft: ${JSON.stringify(setResult.notCreated)}`);
        }

        const submissionId = setResult.created?.submission?.id;
        if (!submissionId) {
            // A submission that reports neither success nor failure must not be
            // reported as sent: the one thing worse than failing to send is
            // saying it was sent when nobody knows.
            throw new Error('The server accepted the submission but returned no id, so it is unclear whether the message was sent.');
        }

        return { emailId, submissionId };
    }

    /**
     * Forward an email
     */
    async forwardEmail(params: {
        originalEmailId: string;
        to: string[];
        comment?: string;
        cc?: string[];
        bcc?: string[];
    }): Promise<{ emailId: string; submissionId: string }> {
        // Get the original email
        const original = await this.getEmailWithBody(params.originalEmailId);

        // Get body content
        let originalBody = '';
        if (original.bodyValues && original.textBody && original.textBody.length > 0) {
            const textPartId = original.textBody[0].partId;
            if (textPartId && original.bodyValues[textPartId]) {
                originalBody = original.bodyValues[textPartId].value;
            }
        }

        // Build forwarded message
        const forwardHeader = [
            '',
            '---------- Forwarded message ----------',
            `From: ${original.from?.map(a => a.name ? `${a.name} <${a.email}>` : a.email).join(', ') || 'Unknown'}`,
            `Date: ${original.sentAt || original.receivedAt}`,
            `Subject: ${original.subject || '(no subject)'}`,
            `To: ${original.to?.map(a => a.name ? `${a.name} <${a.email}>` : a.email).join(', ') || 'Unknown'}`,
            '',
        ].join('\n');

        const textBody = (params.comment ? params.comment + '\n' : '') + forwardHeader + originalBody;

        // Send the forwarded email
        const result = await this.sendEmail({
            to: params.to,
            subject: `Fwd: ${original.subject || '(no subject)'}`,
            textBody,
            cc: params.cc,
            bcc: params.bcc,
        });

        // Mark original as forwarded
        await this.setEmailKeywords([params.originalEmailId], ['$forwarded'], undefined);

        return result;
    }

    // ==========================================================================
    // Mailbox Writing / Management Operations
    // ==========================================================================

    /**
     * Create a new mailbox
     */
    async createMailbox(name: string, parentId?: string | null): Promise<Mailbox> {
        await this.ensureSession();

        const response = await this.request([
            ['Mailbox/set', {
                accountId: this.accountId,
                create: {
                    'new-mailbox': {
                        name,
                        parentId: parentId || null,
                    }
                }
            }, 'a'],
        ]);

        const [responseName, result] = response.methodResponses[0];
        if (responseName === 'error') {
            throw new Error(`Mailbox/set failed: ${JSON.stringify(result)}`);
        }

        const setResult = result as {
            created?: Record<string, Mailbox>;
            notCreated?: Record<string, { type: string; description?: string }>;
        };

        if (setResult.notCreated && Object.keys(setResult.notCreated).length > 0) {
            throw new Error(`Failed to create mailbox: ${JSON.stringify(setResult.notCreated)}`);
        }

        const serverMailbox = setResult.created?.['new-mailbox'];
        if (!serverMailbox) {
            throw new Error('Created mailbox not returned in response');
        }

        return {
            ...serverMailbox,
            name,
            parentId: parentId || null,
        };
    }

    /**
     * Rename a mailbox
     */
    async renameMailbox(id: string, name: string): Promise<void> {
        await this.ensureSession();

        const response = await this.request([
            ['Mailbox/set', {
                accountId: this.accountId,
                update: {
                    [id]: {
                        name,
                    }
                }
            }, 'a'],
        ]);

        const [responseName, result] = response.methodResponses[0];
        if (responseName === 'error') {
            throw new Error(`Mailbox/set failed: ${JSON.stringify(result)}`);
        }

        const setResult = result as {
            notUpdated?: Record<string, { type: string; description?: string }>;
        };

        if (setResult.notUpdated && Object.keys(setResult.notUpdated).length > 0) {
            throw new Error(`Failed to rename mailbox: ${JSON.stringify(setResult.notUpdated)}`);
        }
    }

    /**
     * Delete a mailbox
     */
    async deleteMailbox(id: string, onDestroyRemoveEmails = false): Promise<void> {
        await this.ensureSession();

        const response = await this.request([
            ['Mailbox/set', {
                accountId: this.accountId,
                destroy: [id],
                onDestroyRemoveEmails,
            }, 'a'],
        ]);

        const [responseName, result] = response.methodResponses[0];
        if (responseName === 'error') {
            throw new Error(`Mailbox/set failed: ${JSON.stringify(result)}`);
        }

        const setResult = result as {
            notDestroyed?: Record<string, { type: string; description?: string }>;
        };

        if (setResult.notDestroyed && Object.keys(setResult.notDestroyed).length > 0) {
            throw new Error(`Failed to delete mailbox: ${JSON.stringify(setResult.notDestroyed)}`);
        }
    }

    /**
     * Move a mailbox under a new parent (reorganize hierarchy)
     */
    async moveMailbox(id: string, parentId: string | null): Promise<void> {
        await this.ensureSession();

        const response = await this.request([
            ['Mailbox/set', {
                accountId: this.accountId,
                update: {
                    [id]: {
                        parentId: parentId || null,
                    }
                }
            }, 'a'],
        ]);

        const [responseName, result] = response.methodResponses[0];
        if (responseName === 'error') {
            throw new Error(`Mailbox/set failed: ${JSON.stringify(result)}`);
        }

        const setResult = result as {
            notUpdated?: Record<string, { type: string; description?: string }>;
        };

        if (setResult.notUpdated && Object.keys(setResult.notUpdated).length > 0) {
            throw new Error(`Failed to move mailbox: ${JSON.stringify(setResult.notUpdated)}`);
        }
    }

    // ==========================================================================
    // Contacts Operations (RFC 9610)
    // ==========================================================================

    /**
     * Get address books
     */
    async getAddressBooks(): Promise<AddressBook[]> {
        await this.ensureSession();

        const contactsAccountId = this.session!.primaryAccounts[JMAP_CAPABILITIES.contacts] || this.accountId!;

        const response = await this.request([
            ['AddressBook/get', {
                accountId: contactsAccountId,
                ids: null,
            }, 'a'],
        ]);

        const [responseName, result] = response.methodResponses[0];
        if (responseName === 'error') {
            throw new Error(`AddressBook/get failed: ${JSON.stringify(result)}`);
        }

        return (result as { list: AddressBook[] }).list;
    }

    /**
     * Query contacts (search/list)
     */
    async queryContacts(filter?: ContactCardFilter, limit = 50): Promise<string[]> {
        await this.ensureSession();

        const contactsAccountId = this.session!.primaryAccounts[JMAP_CAPABILITIES.contacts] || this.accountId!;

        const response = await this.request([
            ['ContactCard/query', {
                accountId: contactsAccountId,
                filter,
                limit,
            }, 'a'],
        ]);

        const [responseName, result] = response.methodResponses[0];
        if (responseName === 'error') {
            throw new Error(`ContactCard/query failed: ${JSON.stringify(result)}`);
        }

        return (result as { ids: string[] }).ids;
    }

    /**
     * Get contacts by ID
     */
    async getContacts(ids: string[]): Promise<ContactCard[]> {
        await this.ensureSession();

        if (ids.length === 0) {
            return [];
        }

        const contactsAccountId = this.session!.primaryAccounts[JMAP_CAPABILITIES.contacts] || this.accountId!;

        const response = await this.request([
            ['ContactCard/get', {
                accountId: contactsAccountId,
                ids,
            }, 'a'],
        ]);

        const [responseName, result] = response.methodResponses[0];
        if (responseName === 'error') {
            throw new Error(`ContactCard/get failed: ${JSON.stringify(result)}`);
        }

        return (result as { list: ContactCard[] }).list;
    }

    /**
     * Create a new contact
     */
    async createContact(addressBookId: string, card: Omit<ContactCard, 'id'>): Promise<ContactCard> {
        await this.ensureSession();

        const contactsAccountId = this.session!.primaryAccounts[JMAP_CAPABILITIES.contacts] || this.accountId!;

        const response = await this.request([
            ['ContactCard/set', {
                accountId: contactsAccountId,
                create: {
                    'new-contact': {
                        // The JSContact envelope. Fastmail rejects a create
                        // without these, reporting them as invalid properties
                        // alongside the one that genuinely was wrong.
                        '@type': 'Card',
                        version: '1.0',
                        ...card,
                        // A map, not a single id -- the same shape as mailboxIds.
                        addressBookIds: { [addressBookId]: true },
                    }
                }
            }, 'a'],
        ]);

        const [responseName, result] = response.methodResponses[0];
        if (responseName === 'error') {
            throw new Error(`ContactCard/set failed: ${JSON.stringify(result)}`);
        }

        const setResult = result as {
            created?: Record<string, ContactCard>;
            notCreated?: Record<string, { type: string; description?: string }>;
        };

        if (setResult.notCreated && Object.keys(setResult.notCreated).length > 0) {
            throw new Error(`Failed to create contact: ${JSON.stringify(setResult.notCreated)}`);
        }

        const createdCard = setResult.created?.['new-contact'];
        if (!createdCard) {
            throw new Error('Created contact not returned in response');
        }

        return {
            ...card,
            ...createdCard,
        } as unknown as ContactCard;
    }

    /**
     * Update an existing contact (JSContact patch)
     */
    async updateContact(id: string, patch: Record<string, unknown>): Promise<void> {
        await this.ensureSession();

        const contactsAccountId = this.session!.primaryAccounts[JMAP_CAPABILITIES.contacts] || this.accountId!;

        const response = await this.request([
            ['ContactCard/set', {
                accountId: contactsAccountId,
                update: {
                    [id]: patch,
                }
            }, 'a'],
        ]);

        const [responseName, result] = response.methodResponses[0];
        if (responseName === 'error') {
            throw new Error(`ContactCard/set failed: ${JSON.stringify(result)}`);
        }

        const setResult = result as {
            notUpdated?: Record<string, { type: string; description?: string }>;
        };

        if (setResult.notUpdated && Object.keys(setResult.notUpdated).length > 0) {
            throw new Error(`Failed to update contact: ${JSON.stringify(setResult.notUpdated)}`);
        }
    }

    /**
     * Delete a contact
     */
    async deleteContact(id: string): Promise<void> {
        await this.ensureSession();

        const contactsAccountId = this.session!.primaryAccounts[JMAP_CAPABILITIES.contacts] || this.accountId!;

        const response = await this.request([
            ['ContactCard/set', {
                accountId: contactsAccountId,
                destroy: [id],
            }, 'a'],
        ]);

        const [responseName, result] = response.methodResponses[0];
        if (responseName === 'error') {
            throw new Error(`ContactCard/set failed: ${JSON.stringify(result)}`);
        }

        const setResult = result as {
            notDestroyed?: Record<string, { type: string; description?: string }>;
        };

        if (setResult.notDestroyed && Object.keys(setResult.notDestroyed).length > 0) {
            throw new Error(`Failed to delete contact: ${JSON.stringify(setResult.notDestroyed)}`);
        }
    }
}

// Client cache for multi-account support
const clientCache = new Map<string, JMAPClient>();

export function getClient(config: AccountConfig): JMAPClient {
    const key = config.name;
    let client = clientCache.get(key);

    if (!client) {
        client = new JMAPClient(config);
        clientCache.set(key, client);
    }

    return client;
}

export function clearClientCache(): void {
    clientCache.clear();
}
