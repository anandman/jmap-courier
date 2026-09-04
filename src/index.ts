/**
 * JMAP Courier - A provider-agnostic JMAP client library
 *
 * This library implements the JMAP (JSON Meta Application Protocol) standard
 * for email operations. It's designed to work with any JMAP-compliant provider.
 */

// Core client
export {
    JMAPClient,
    getClient,
    clearClientCache,
    WELL_KNOWN_MAILBOX_ROLES,
    capabilitiesFor,
} from './jmap-client.js';

// Types - Core JMAP
export type {
    JMAPSession,
    JMAPResponse,
    JMAPMethodCall,
    JMAPMethodResponse,
} from './types.js';

// Types - Mail
export type {
    Mailbox,
    Email,
    EmailAddress,
    EmailBodyPart,
    EmailBodyValue,
    EmailHeader,
    EmailSummary,
    EmailFilter,
    EmailSort,
} from './types.js';

// Types - Submission
export type {
    EmailSubmission,
} from './types.js';

// Types - Configuration
export type {
    AccountConfig,
    MultiAccountConfig,
} from './types.js';

// Types - Contacts
export type {
    AddressBook,
    ContactCard,
    ContactCardFilter,
} from './types.js';

