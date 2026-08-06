/**
 * Mailbox resolution: role before name.
 *
 * Modelled on a real account where an IMAP import left a `migrated/` tree full
 * of folders with standard names and no roles. Asking for "Junk" found the
 * empty `migrated/Junk` instead of the actual junk folder, which Fastmail names
 * "Spam" -- a well-formed response with zero results and nothing to indicate the
 * folder searched was not the folder meant.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JMAPClient, WELL_KNOWN_MAILBOX_ROLES } from '../src/index.js';
import type { Mailbox } from '../src/index.js';

const mailbox = (
    id: string,
    name: string,
    role: string | null,
    parentId: string | null = null,
    totalEmails = 0
): Mailbox =>
    ({
        id,
        name,
        parentId,
        role,
        sortOrder: 0,
        totalEmails,
        unreadEmails: 0,
        totalThreads: 0,
        unreadThreads: 0,
        isSubscribed: true,
        myRights: {} as Mailbox['myRights'],
    }) as Mailbox;

// Canonical folders first, shadows second -- the order the live account returns,
// which is exactly why name matching appeared to work for everything but Junk.
const ACCOUNT: Mailbox[] = [
    mailbox('P-F', 'Inbox', 'inbox', null, 40000),
    mailbox('P3k', 'Drafts', 'drafts', null, 11),
    mailbox('P6F', 'Sent', 'sent', null, 1200),
    mailbox('P3-', 'Archive', 'archive', null, 1),
    mailbox('P7-', 'Trash', 'trash', null, 9000),
    mailbox('P6k', 'Spam', 'junk', null, 640),
    mailbox('P7F', 'migrated', null),
    mailbox('P9k', 'Junk', null, 'P7F', 0),
    mailbox('PCV', 'Sent', null, 'P7F', 3100),
    mailbox('P7k', 'Archive', null, 'P7F', 0),
    mailbox('P8F', 'Drafts', null, 'P7F', 0),
    mailbox('P5k', 'Project Notes', null, null, 88),
];

function client(): JMAPClient {
    const c = new JMAPClient({
        name: 'test',
        token: 'test-token',
        sessionUrl: 'https://example.com/jmap/session',
    });
    vi.spyOn(c, 'getMailboxes').mockResolvedValue(ACCOUNT);
    return c;
}

describe('resolveMailbox', () => {
    let c: JMAPClient;
    beforeEach(() => {
        c = client();
    });

    it('finds the junk folder by role even though it is named Spam', async () => {
        // The original bug. Name matching could never find it: the only mailbox
        // actually named "Junk" is the empty import artefact.
        const resolved = await c.resolveMailbox('Junk');

        expect(resolved?.id).toBe('P6k');
        expect(resolved?.name).toBe('Spam');
        expect(resolved?.totalEmails).toBe(640);
    });

    it('accepts the provider name for the same folder', async () => {
        expect((await c.resolveMailbox('Spam'))?.id).toBe('P6k');
    });

    it('prefers the real Sent over a shadow holding more mail', async () => {
        // The dangerous one: the shadow holds more mail than the real
        // folder, so a wrong answer looks entirely plausible.
        const resolved = await c.resolveMailbox('Sent');

        expect(resolved?.id).toBe('P6F');
        expect(resolved?.parentId).toBeNull();
    });

    it.each([
        ['Inbox', 'P-F'],
        ['Drafts', 'P3k'],
        ['Archive', 'P3-'],
        ['Trash', 'P7-'],
    ])('resolves %s by role, not by array order', async (name, expected) => {
        expect((await c.resolveMailbox(name))?.id).toBe(expected);
    });

    it('is case-insensitive', async () => {
        expect((await c.resolveMailbox('jUnK'))?.id).toBe('P6k');
    });

    it('accepts common aliases for roles', async () => {
        expect((await c.resolveMailbox('Bin'))?.id).toBe('P7-');
        expect((await c.resolveMailbox('Deleted Messages'))?.id).toBe('P7-');
    });

    it('still reaches a shadowed folder by its full path', async () => {
        // Resolving by role must not make the other folder unreachable; the
        // client may genuinely want the imported one.
        const resolved = await c.resolveMailbox('migrated/Junk');

        expect(resolved?.id).toBe('P9k');
        expect(resolved?.totalEmails).toBe(0);
    });

    it('matches a path case-insensitively', async () => {
        expect((await c.resolveMailbox('MIGRATED/SENT'))?.id).toBe('PCV');
    });

    it('resolves an ordinary folder by name', async () => {
        expect((await c.resolveMailbox('Project Notes'))?.id).toBe('P5k');
    });

    it('resolves by id ahead of anything else', async () => {
        expect((await c.resolveMailbox('P9k'))?.id).toBe('P9k');
    });

    it('returns null for a folder that does not exist', async () => {
        expect(await c.resolveMailbox('Nonexistent')).toBeNull();
    });

    it('returns null for an empty query rather than guessing', async () => {
        expect(await c.resolveMailbox('   ')).toBeNull();
    });

    it('prefers a role-bearing folder when only leaf names collide', async () => {
        // No well-known token and no path given: two folders share a leaf name
        // and the one with a role is the real one.
        const c2 = new JMAPClient({
            name: 'test',
            token: 't',
            sessionUrl: 'https://example.com/jmap/session',
        });
        vi.spyOn(c2, 'getMailboxes').mockResolvedValue([
            mailbox('shadow', 'Templates', null, null, 0),
            mailbox('real', 'Templates', 'templates', null, 5),
        ]);

        expect((await c2.resolveMailbox('Templates'))?.id).toBe('real');
    });
});

describe('WELL_KNOWN_MAILBOX_ROLES', () => {
    it('maps every alias to a real JMAP role', () => {
        const roles = new Set([
            'inbox',
            'sent',
            'drafts',
            'archive',
            'junk',
            'trash',
            'snoozed',
            'scheduled',
            'templates',
        ]);

        for (const [alias, role] of Object.entries(WELL_KNOWN_MAILBOX_ROLES)) {
            expect(roles, `${alias} -> ${role}`).toContain(role);
        }
    });

    it('is keyed in lower case, since lookups are lowercased', () => {
        for (const alias of Object.keys(WELL_KNOWN_MAILBOX_ROLES)) {
            expect(alias).toBe(alias.toLowerCase());
        }
    });
});
