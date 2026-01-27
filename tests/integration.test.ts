/**
 * Integration tests for jmap-courier library
 * 
 * These tests require a real JMAP server and API token.
 * Set environment variables before running:
 *   JMAP_API_TOKEN - Your API token
 *   JMAP_SESSION_URL - Your provider's session URL
 * 
 * For Fastmail:
 *   export JMAP_SESSION_URL=https://api.fastmail.com/jmap/session
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { JMAPClient } from '../src/index.js';
import type { AccountConfig } from '../src/index.js';

// Test configuration from environment
const testConfig = {
    token: process.env.JMAP_API_TOKEN || process.env.FASTMAIL_API_TOKEN,
    sessionUrl: process.env.JMAP_SESSION_URL || 'https://api.fastmail.com/jmap/session',

    get isConfigured(): boolean {
        return !!this.token;
    }
};

describe('JMAPClient Integration', () => {
    let client: JMAPClient;

    beforeAll(() => {
        if (!testConfig.isConfigured) {
            console.warn('⚠️  Integration tests skipped: Set JMAP_API_TOKEN environment variable');
            return;
        }

        const config: AccountConfig = {
            name: 'test',
            token: testConfig.token!,
            sessionUrl: testConfig.sessionUrl,
        };
        client = new JMAPClient(config);
    });

    it('can fetch JMAP session', async () => {
        if (!testConfig.isConfigured) return;

        const session = await client.fetchSession();

        expect(session).toBeDefined();
        expect(session.username).toBeDefined();
        expect(session.apiUrl).toBeDefined();
        expect(session.primaryAccounts).toBeDefined();
    });

    it('can get mailboxes', async () => {
        if (!testConfig.isConfigured) return;

        const mailboxes = await client.getMailboxes();

        expect(mailboxes).toBeDefined();
        expect(Array.isArray(mailboxes)).toBe(true);
        expect(mailboxes.length).toBeGreaterThan(0);

        // Should have standard mailboxes
        const roles = mailboxes.map(m => m.role).filter(Boolean);
        expect(roles).toContain('inbox');
    });

    it('can query emails', async () => {
        if (!testConfig.isConfigured) return;

        const emailIds = await client.queryEmails(undefined, undefined, 5);

        expect(emailIds).toBeDefined();
        expect(Array.isArray(emailIds)).toBe(true);
    });
});
