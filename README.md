# JMAP Courier

A TypeScript JMAP client for email that works with any JMAP-compliant provider.

Implements [RFC 8620](https://datatracker.ietf.org/doc/html/rfc8620) (JMAP Core) and [RFC 8621](https://datatracker.ietf.org/doc/html/rfc8621) (JMAP Mail).

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

## Multi-Account Support

### Environment Variables

```bash
export JMAP_API_TOKEN="your-token"
export JMAP_SESSION_URL="https://api.fastmail.com/jmap/session"
export JMAP_EMAIL="user@example.com"  # Optional account name
```

### Config File

Create `~/.config/jmap-courier/accounts.json`:

```json
{
    "accounts": [
        {
            "name": "personal",
            "token": "token-1",
            "sessionUrl": "https://api.fastmail.com/jmap/session"
        },
        {
            "name": "work",
            "token": "token-2", 
            "sessionUrl": "https://api.fastmail.com/jmap/session"
        }
    ],
    "defaultAccount": "personal"
}
```

Then use the account manager:

```typescript
import { getAccountManager, getClient } from 'jmap-courier';

const manager = getAccountManager();
const account = manager.getCurrentAccount();
const client = getClient(account);
```

## API Reference

### JMAPClient

- `fetchSession()` - Initialize connection and get account info
- `getMailboxes()` - List all mailboxes
- `getMailboxByRole(role)` - Find mailbox by role (inbox, trash, sent, etc.)
- `queryEmails(filter?, sort?, limit?)` - Search for emails
- `getEmails(ids, properties?)` - Get emails by ID
- `getEmailWithBody(id)` - Get full email with body content
- `moveEmails(ids, mailboxId)` - Move emails to mailbox
- `deleteEmails(ids)` - Move emails to trash
- `markEmailsRead(ids, isRead)` - Mark as read/unread
- `markEmailsFlagged(ids, isFlagged)` - Flag/unflag emails
- `sendEmail(params)` - Send a new email
- `forwardEmail(params)` - Forward an email

## Credits

Copyright © 2026 Anand Mandapati

Created with AI using [Antigravity](https://github.com/google-deepmind/antigravity) and Claude Opus.

## License

MIT - see [LICENSE](LICENSE) for details.
