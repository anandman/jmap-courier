/**
 * JMAP Types
 * Based on RFC 8620 (JMAP Core) and RFC 8621 (JMAP Mail)
 */

// ============================================================================
// JMAP Core Types
// ============================================================================

export interface JMAPSession {
    capabilities: Record<string, unknown>;
    accounts: Record<string, JMAPAccount>;
    primaryAccounts: Record<string, string>;
    username: string;
    apiUrl: string;
    downloadUrl: string;
    uploadUrl: string;
    eventSourceUrl: string;
    state: string;
}

export interface JMAPAccount {
    name: string;
    isPersonal: boolean;
    isReadOnly: boolean;
    accountCapabilities: Record<string, unknown>;
}

export interface JMAPRequest {
    using: string[];
    methodCalls: JMAPMethodCall[];
}

export type JMAPMethodCall = [string, Record<string, unknown>, string];

export interface JMAPResponse {
    methodResponses: JMAPMethodResponse[];
    sessionState: string;
}

export type JMAPMethodResponse = [string, Record<string, unknown>, string];

export interface JMAPError {
    type: string;
    description?: string;
}

// ============================================================================
// JMAP Mail Types
// ============================================================================

export interface Mailbox {
    id: string;
    name: string;
    parentId: string | null;
    role: string | null;
    sortOrder: number;
    totalEmails: number;
    unreadEmails: number;
    totalThreads: number;
    unreadThreads: number;
    myRights: MailboxRights;
    isSubscribed: boolean;
}

export interface MailboxRights {
    mayReadItems: boolean;
    mayAddItems: boolean;
    mayRemoveItems: boolean;
    maySetSeen: boolean;
    maySetKeywords: boolean;
    mayCreateChild: boolean;
    mayRename: boolean;
    mayDelete: boolean;
    maySubmit: boolean;
}

export interface Email {
    id: string;
    blobId: string;
    threadId: string;
    mailboxIds: Record<string, boolean>;
    keywords: Record<string, boolean>;
    size: number;
    receivedAt: string;
    messageId: string[] | null;
    inReplyTo: string[] | null;
    references: string[] | null;
    sender: EmailAddress[] | null;
    from: EmailAddress[] | null;
    to: EmailAddress[] | null;
    cc: EmailAddress[] | null;
    bcc: EmailAddress[] | null;
    replyTo: EmailAddress[] | null;
    subject: string | null;
    sentAt: string | null;
    hasAttachment: boolean;
    preview: string;
    bodyStructure?: EmailBodyPart;
    bodyValues?: Record<string, EmailBodyValue>;
    textBody?: EmailBodyPart[];
    htmlBody?: EmailBodyPart[];
    attachments?: EmailBodyPart[];
}

export interface EmailAddress {
    name: string | null;
    email: string;
}

export interface EmailBodyPart {
    partId: string | null;
    blobId: string | null;
    size: number;
    headers?: EmailHeader[];
    name: string | null;
    type: string;
    charset: string | null;
    disposition: string | null;
    cid: string | null;
    language: string[] | null;
    location: string | null;
    subParts?: EmailBodyPart[];
}

export interface EmailBodyValue {
    value: string;
    isEncodingProblem: boolean;
    isTruncated: boolean;
}

export interface EmailHeader {
    name: string;
    value: string;
}

// ============================================================================
// JMAP Submission Types
// ============================================================================

export interface Identity {
    id: string;
    name: string;
    email: string;
    replyTo: EmailAddress[] | null;
    bcc: EmailAddress[] | null;
    textSignature: string;
    htmlSignature: string;
    mayDelete: boolean;
}

export interface EmailSubmission {
    id: string;
    identityId: string;
    emailId: string;
    threadId: string;
    envelope: Envelope | null;
    sendAt: string;
    undoStatus: 'pending' | 'final' | 'canceled';
    deliveryStatus: Record<string, DeliveryStatus> | null;
    dsnBlobIds: string[];
    mdnBlobIds: string[];
}

export interface Envelope {
    mailFrom: EnvelopeAddress;
    rcptTo: EnvelopeAddress[];
}

export interface EnvelopeAddress {
    email: string;
    parameters: Record<string, string> | null;
}

export interface DeliveryStatus {
    smtpReply: string;
    delivered: 'queued' | 'yes' | 'no' | 'unknown';
    displayed: 'yes' | 'unknown';
}

// ============================================================================
// Query and Filter Types
// ============================================================================

export interface EmailQuery {
    accountId: string;
    filter?: EmailFilter;
    sort?: EmailSort[];
    position?: number;
    anchor?: string;
    anchorOffset?: number;
    limit?: number;
    calculateTotal?: boolean;
}

export interface EmailFilter {
    inMailbox?: string;
    inMailboxOtherThan?: string[];
    before?: string;
    after?: string;
    minSize?: number;
    maxSize?: number;
    allInThreadHaveKeyword?: string;
    someInThreadHaveKeyword?: string;
    noneInThreadHaveKeyword?: string;
    hasKeyword?: string;
    notKeyword?: string;
    hasAttachment?: boolean;
    text?: string;
    from?: string;
    to?: string;
    cc?: string;
    bcc?: string;
    subject?: string;
    body?: string;
    header?: [string, string];
}

export interface EmailSort {
    property: string;
    isAscending?: boolean;
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface AccountConfig {
    /** Account name/identifier */
    name: string;
    /** API token for authentication */
    token: string;
    /** JMAP session URL (required - provider specific) */
    sessionUrl: string;
}

export interface MultiAccountConfig {
    accounts: AccountConfig[];
    defaultAccount: string;
}

// ============================================================================
// Convenience Types
// ============================================================================

/** One page of the Email change feed, with the state to resume from. */
export interface EmailChanges {
    /** Pass as `sinceState` next time. Only store it after a clean return. */
    newState: string;
    /** More changes remain beyond maxChanges; call again with newState. */
    hasMoreChanges: boolean;
    created: Email[];
    updated: Email[];
    /**
     * Genuinely expunged. A message moved to Trash arrives in `updated` with
     * changed mailboxIds, not here -- watching only this list is how an archive
     * silently diverges from the mailbox.
     */
    destroyedIds: string[];
}

export interface EmailSummary {
    id: string;
    threadId: string;
    /**
     * RFC 5322 Message-ID. An array because the header may legally repeat,
     * though in practice it holds one entry; null when the message carries no
     * Message-ID at all, which happens for unsubmitted drafts and some
     * gateway-originated mail. Callers must handle the absence rather than
     * indexing [0] blindly.
     */
    messageId: string[] | null;
    inReplyTo: string[] | null;
    references: string[] | null;
    subject: string | null;
    from: EmailAddress[] | null;
    to: EmailAddress[] | null;
    receivedAt: string;
    preview: string;
    hasAttachment: boolean;
    isRead: boolean;
    isFlagged: boolean;
}

// ============================================================================
// JMAP Contacts Types (RFC 9610 / JSContact RFC 9553)
// ============================================================================

export interface AddressBook {
    id: string;
    name: string;
    parentId: string | null;
    isDefault: boolean;
}

export interface ContactCard {
    id: string;
    addressBookId?: string;
    uid?: string;
    prodId?: string;
    kind?: 'individual' | 'group' | 'org' | 'location' | 'device' | 'application';
    name?: ContactName;
    emails?: Record<string, ContactEmail>;
    phones?: Record<string, ContactPhone>;
    addresses?: Record<string, ContactAddress>;
    organizations?: Record<string, ContactOrganization>;
    notes?: string;
}

export interface ContactName {
    fullName?: string;
}

export interface ContactEmail {
    address: string;
    contexts?: Record<string, boolean>;
}

export interface ContactPhone {
    number: string;
    contexts?: Record<string, boolean>;
}

export interface ContactAddress {
    fullAddress?: string;
    street?: string;
    city?: string;
    region?: string;
    country?: string;
    postcode?: string;
    contexts?: Record<string, boolean>;
}

export interface ContactOrganization {
    name: string;
    title?: string;
}

export interface ContactCardQuery {
    accountId: string;
    filter?: ContactCardFilter;
    limit?: number;
}

export interface ContactCardFilter {
    addressBookId?: string;
    text?: string;
}

