/**
 * Unit tests for jmap-courier library
 * 
 * These tests verify the library API without making actual network calls.
 * For integration tests that hit a real JMAP server, see integration.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { JMAPClient } from '../src/index.js';
import type { AccountConfig, Email, Mailbox } from '../src/index.js';

describe('JMAPClient', () => {
    describe('constructor', () => {
        it('requires sessionUrl in AccountConfig', () => {
            const configWithoutUrl = {
                name: 'test',
                token: 'test-token',
            } as AccountConfig;

            expect(() => new JMAPClient(configWithoutUrl)).toThrow(
                'sessionUrl is required in AccountConfig'
            );
        });

        it('accepts valid AccountConfig with sessionUrl', () => {
            const config: AccountConfig = {
                name: 'test',
                token: 'test-token',
                sessionUrl: 'https://example.com/jmap/session',
            };

            const client = new JMAPClient(config);
            expect(client).toBeDefined();
        });
    });
});

describe('Type exports', () => {
    it('exports AccountConfig type', () => {
        const config: AccountConfig = {
            name: 'test',
            token: 'token',
            sessionUrl: 'https://example.com/jmap/session',
        };
        expect(config.name).toBe('test');
        expect(config.sessionUrl).toBe('https://example.com/jmap/session');
    });

    it('exports Email type', () => {
        const email: Partial<Email> = {
            id: 'email-123',
            threadId: 'thread-456',
            subject: 'Test Subject',
        };
        expect(email.id).toBe('email-123');
    });

    it('exports Mailbox type', () => {
        const mailbox: Partial<Mailbox> = {
            id: 'mailbox-123',
            name: 'Inbox',
            role: 'inbox',
        };
        expect(mailbox.name).toBe('Inbox');
    });
});
