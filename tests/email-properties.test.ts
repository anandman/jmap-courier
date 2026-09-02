/**
 * Which properties Email/get actually asks for.
 *
 * messageId/inReplyTo/references are header-derived properties that ride along
 * on the Email/get already being made -- no extra round trip, no body fetch. The
 * risk is not that they cost something; it is that they are silently dropped
 * from a property list during an unrelated edit, and callers then see undefined
 * where they expected null-or-value. These pin the request itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '../src/index.js';

const IDENTITY_HEADERS = ['messageId', 'inReplyTo', 'references'];

function client(): JMAPClient {
    const c = new JMAPClient({
        name: 'test',
        token: 'test-token',
        sessionUrl: 'https://example.com/jmap/session',
    });
    // Session fetch and transport are both stubbed: we assert on the request
    // that would go out, not on a response.
    (c as unknown as { ensureSession: () => Promise<void> }).ensureSession = async () => undefined;
    (c as unknown as { accountId: string }).accountId = 'acct-1';
    return c;
}

/** Captures the `properties` array from the first method call of a request. */
function captureProperties(c: JMAPClient): () => string[] {
    let captured: string[] = [];
    (c as unknown as { request: (calls: unknown[]) => Promise<unknown> }).request = async (
        calls: unknown[]
    ) => {
        const [, args] = calls[0] as [string, { properties?: string[] }, string];
        captured = args.properties ?? [];
        return { methodResponses: [['Email/get', { list: [] }, 'a']] };
    };
    return () => captured;
}

describe('getEmails', () => {
    let c: JMAPClient;
    let properties: () => string[];

    beforeEach(() => {
        c = client();
        properties = captureProperties(c);
    });

    it.each(IDENTITY_HEADERS)('requests %s by default', async (header) => {
        await c.getEmails(['E1']);

        expect(properties()).toContain(header);
    });

    it('still requests the fields the summary view already relied on', async () => {
        await c.getEmails(['E1']);

        expect(properties()).toEqual(
            expect.arrayContaining(['id', 'threadId', 'subject', 'from', 'preview', 'receivedAt'])
        );
    });

    it('does not fetch body values, so the summary path stays cheap', async () => {
        await c.getEmails(['E1']);

        expect(properties()).not.toContain('bodyValues');
    });

    it('lets an explicit property list win, so callers can still ask for less', async () => {
        await c.getEmails(['E1'], ['id', 'subject']);

        expect(properties()).toEqual(['id', 'subject']);
    });

    it('makes no request at all for an empty id list', async () => {
        const result = await c.getEmails([]);

        expect(result).toEqual([]);
        expect(properties()).toEqual([]);
    });
});

describe('getEmailWithBody', () => {
    it.each(IDENTITY_HEADERS)('requests %s alongside the body', async (header) => {
        const c = client();
        const properties = captureProperties(c);
        // The single-message path builds its own list rather than reusing the
        // default, so it can drift from getEmails independently.
        await c.getEmailWithBody('E1').catch(() => undefined);

        expect(properties()).toContain(header);
    });
});
