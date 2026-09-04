/**
 * JMAP Client
 * Implements core JMAP protocol operations per RFC 8620 and RFC 8621
 * Works with any JMAP-compliant email provider
 */

import type {
    JMAPSession,
    JMAPRequest,
    JMAPResponse,
    JMAPMethodCall,
    AccountConfig,
    Mailbox,
    Email,
    EmailQuery,
    EmailFilter,
    EmailSort,
    Identity,
    AddressBook,
    ContactCard,
    ContactCardFilter,
} from './types.js';

export const JMAP_CAPABILITIES = {
    core: 'urn:ietf:params:jmap:core',
    mail: 'urn:ietf:params:jmap:mail',
    submission: 'urn:ietf:params:jmap:submission',
    contacts: 'urn:ietf:params:jmap:contacts',
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
    async queryEmails(filter?: EmailFilter, sort?: EmailSort[], limit = 50): Promise<string[]> {
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
        filter?: EmailFilter,
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
     * Get emails by ID with specified properties
     */
    async getEmails(ids: string[], properties?: string[]): Promise<Email[]> {
        await this.ensureSession();

        if (ids.length === 0) {
            return [];
        }

        // messageId/inReplyTo/references are header-derived properties returned by
        // this same Email/get -- they cost no extra round trip and no body fetch.
        // Callers need messageId to build an RFC 5322 `message://` link that opens
        // a desktop mail client; the JMAP id only addresses the web app.
        const defaultProperties = [
            'id', 'blobId', 'threadId', 'mailboxIds', 'keywords',
            'receivedAt', 'from', 'to', 'cc', 'bcc', 'replyTo',
            'subject', 'sentAt', 'hasAttachment', 'preview',
            'messageId', 'inReplyTo', 'references',
        ];

        const response = await this.request([
            ['Email/get', {
                accountId: this.accountId,
                ids,
                properties: properties || defaultProperties,
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

        const setResult = result as { notUpdated?: Record<string, { type: string; description?: string }> };
        if (setResult.notUpdated && Object.keys(setResult.notUpdated).length > 0) {
            throw new Error(`Failed to update some emails: ${JSON.stringify(setResult.notUpdated)}`);
        }
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

        // Create the email and submit in one request using result references
        const emailCreate: Record<string, unknown> = {
            mailboxIds: { [drafts.id]: true },
            from: [{ email: identity.email, name: identity.name || null }],
            to: params.to.map(email => ({ email, name: null })),
            subject: params.subject,
            textBody: [{ partId: 'text', type: 'text/plain' }],
            bodyValues: {
                text: { value: params.textBody, isEncodingProblem: false, isTruncated: false },
            },
            keywords: { $draft: true },
        };

        if (params.cc && params.cc.length > 0) {
            emailCreate.cc = params.cc.map(email => ({ email, name: null }));
        }
        if (params.bcc && params.bcc.length > 0) {
            emailCreate.bcc = params.bcc.map(email => ({ email, name: null }));
        }
        if (params.replyTo) {
            emailCreate.replyTo = [{ email: params.replyTo, name: null }];
        }
        if (params.htmlBody) {
            emailCreate.htmlBody = [{ partId: 'html', type: 'text/html' }];
            (emailCreate.bodyValues as Record<string, unknown>).html = {
                value: params.htmlBody,
                isEncodingProblem: false,
                isTruncated: false
            };
        }
        if (params.inReplyTo) {
            emailCreate.inReplyTo = [params.inReplyTo];
        }
        if (params.references) {
            emailCreate.references = params.references;
        }

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
                        ...card,
                        addressBookId,
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
