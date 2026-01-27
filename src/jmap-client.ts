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
} from './types.js';

const JMAP_CAPABILITIES = {
    core: 'urn:ietf:params:jmap:core',
    mail: 'urn:ietf:params:jmap:mail',
    submission: 'urn:ietf:params:jmap:submission',
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
    async request(methodCalls: JMAPMethodCall[]): Promise<JMAPResponse> {
        await this.ensureSession();

        const request: JMAPRequest = {
            using: [JMAP_CAPABILITIES.core, JMAP_CAPABILITIES.mail, JMAP_CAPABILITIES.submission],
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
     * Find mailbox by ID or name
     */
    async resolveMailbox(idOrName: string): Promise<Mailbox | null> {
        const mailboxes = await this.getMailboxes();
        // First try by ID
        const byId = mailboxes.find(m => m.id === idOrName);
        if (byId) return byId;
        // Then by name (case-insensitive)
        return mailboxes.find(m => m.name.toLowerCase() === idOrName.toLowerCase()) || null;
    }

    // ==========================================================================
    // Email Query Operations
    // ==========================================================================

    /**
     * Query emails with filters
     */
    async queryEmails(filter?: EmailFilter, sort?: EmailSort[], limit = 50): Promise<string[]> {
        await this.ensureSession();

        const query: EmailQuery = {
            accountId: this.accountId!,
            filter,
            sort: sort || [{ property: 'receivedAt', isAscending: false }],
            limit,
            calculateTotal: true,
        };

        const response = await this.request([
            ['Email/query', query as unknown as Record<string, unknown>, 'a'],
        ]);

        const [name, result] = response.methodResponses[0];
        if (name === 'error') {
            throw new Error(`Email/query failed: ${JSON.stringify(result)}`);
        }

        return (result as { ids: string[] }).ids;
    }

    /**
     * Get emails by ID with specified properties
     */
    async getEmails(ids: string[], properties?: string[]): Promise<Email[]> {
        await this.ensureSession();

        if (ids.length === 0) {
            return [];
        }

        const defaultProperties = [
            'id', 'blobId', 'threadId', 'mailboxIds', 'keywords',
            'receivedAt', 'from', 'to', 'cc', 'bcc', 'replyTo',
            'subject', 'sentAt', 'hasAttachment', 'preview',
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
