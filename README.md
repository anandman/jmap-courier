# JMAP Courier

A TypeScript JMAP client for email and contacts that works with any JMAP-compliant provider.

Implements [RFC 8620](https://datatracker.ietf.org/doc/html/rfc8620) (JMAP Core), [RFC 8621](https://datatracker.ietf.org/doc/html/rfc8621) (JMAP Mail), and [RFC 9610](https://datatracker.ietf.org/doc/html/rfc9610) (JMAP Contacts).

## Installation

```bash
npm install jmap-courier
```

## Quick Start

```typescript
import { JMAPClient } from 'jmap-courier';

const client = new JMAPClient({
    name: 'my-account',
    token: 'your-api-token',
    sessionUrl: 'https://api.fastmail.com/jmap/session', // Provider-specific
});

// Fetch session and list mailboxes
await client.fetchSession();
const mailboxes = await client.getMailboxes();

// Search emails
const emailIds = await client.queryEmails({ inMailbox: 'inbox-id' });
const emails = await client.getEmails(emailIds);

// Send an email
await client.sendEmail({
    to: ['recipient@example.com'],
    subject: 'Hello',
    textBody: 'Hello from JMAP Courier!',
});
```

## Provider Session URLs

| Provider | Session URL |
|----------|-------------|
| Fastmail | `https://api.fastmail.com/jmap/session` |
| Cyrus | `https://your-server/.well-known/jmap` |
| Stalwart | `https://your-server/.well-known/jmap` |


## API Reference

### JMAPClient

- `fetchSession()` - Initialize connection and get account info
- `getMailboxes()` - List all mailboxes
- `getMailboxByRole(role)` - Find mailbox by role (inbox, trash, sent, etc.)
- `createMailbox(name, parentId?)` - Create a new mailbox/folder
- `renameMailbox(id, name)` - Rename an existing mailbox
- `deleteMailbox(id, onDestroyRemoveEmails?)` - Delete an existing mailbox
- `moveMailbox(id, parentId)` - Move a mailbox under a new parent
- `queryEmails(filter?, sort?, limit?)` - Search for emails
- `getEmails(ids, properties?)` - Get emails by ID
- `getEmailWithBody(id)` - Get full email with body content
- `moveEmails(ids, mailboxId)` - Move emails to mailbox
- `deleteEmails(ids)` - Move emails to trash
- `markEmailsRead(ids, isRead)` - Mark as read/unread
- `markEmailsFlagged(ids, isFlagged)` - Flag/unflag emails
- `sendEmail(params)` - Send a new email
- `forwardEmail(params)` - Forward an email
- `getAddressBooks()` - List contact address books (RFC 9610)
- `queryContacts(filter?, limit?)` - Search for contact card IDs
- `getContacts(ids)` - Retrieve contact cards by IDs
- `createContact(addressBookId, card)` - Create a new contact card
- `updateContact(id, patch)` - Update a contact card using JSContact patches
- `deleteContact(id)` - Delete a contact card by ID

## Credits

Copyright © 2026 Anand Mandapati

Created with AI using [Antigravity](https://github.com/google-deepmind/antigravity) and Claude Opus.

## License

MIT - see [LICENSE](LICENSE) for details.
