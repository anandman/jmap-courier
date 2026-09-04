/**
 * The `using` array must describe the request, not the client.
 *
 * Every request used to declare core+mail+submission unconditionally. RFC 8620
 * 4.1 says `using` names the capabilities the *methods in this request* need,
 * and over-declaring is not free: a server that scopes a credential rejects the
 * whole request on an unpermitted capability, before any method runs.
 *
 * Found live. A read-only Fastmail token could not run `Email/query` -- a pure
 * read -- because the request also asked for submission:
 *
 *   403 Forbidden — "Disallowed capabilities for this type/client:
 *   urn:ietf:params:jmap:submission"
 */

import { describe, it, expect } from 'vitest';
import { capabilitiesFor } from '../src/index.js';
import type { JMAPMethodCall } from '../src/index.js';

const call = (method: string): JMAPMethodCall => [method, {}, 'a'];

const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';
const SUBMISSION = 'urn:ietf:params:jmap:submission';
const CONTACTS = 'urn:ietf:params:jmap:contacts';

describe('read paths do not ask to send', () => {
    it.each([
        'Email/query',
        'Email/get',
        'Email/set',
        'Mailbox/get',
        'Mailbox/set',
    ])('%s asks for mail but not submission', (method) => {
        const using = capabilitiesFor([call(method)]);

        expect(using).toContain(MAIL);
        expect(using).not.toContain(SUBMISSION);
    });

    it('the exact request that a read-only token could not run', () => {
        // search_emails is Email/query then Email/get.
        const using = capabilitiesFor([call('Email/query'), call('Email/get')]);

        expect(using.sort()).toEqual([CORE, MAIL].sort());
    });

    it('Email/set stays on mail, since moving and flagging are not sending', () => {
        expect(capabilitiesFor([call('Email/set')])).not.toContain(SUBMISSION);
    });
});

describe('send paths ask for submission, and still fail loudly without it', () => {
    it.each(['EmailSubmission/set', 'Identity/get'])('%s asks for submission', (method) => {
        expect(capabilitiesFor([call(method)])).toContain(SUBMISSION);
    });

    it('a send that creates and submits asks for both', () => {
        // send_email builds the Email and submits it in one request.
        const using = capabilitiesFor([call('Email/set'), call('EmailSubmission/set')]);

        expect(using).toContain(MAIL);
        expect(using).toContain(SUBMISSION);
    });
});

describe('contacts', () => {
    it.each(['AddressBook/get', 'ContactCard/query', 'ContactCard/set'])(
        '%s asks for contacts only',
        (method) => {
            const using = capabilitiesFor([call(method)]);

            expect(using).toContain(CONTACTS);
            expect(using).not.toContain(MAIL);
            expect(using).not.toContain(SUBMISSION);
        }
    );

    it('no longer leaks onto mail requests', () => {
        // Contacts used to be added to every request whenever the *server*
        // advertised it, regardless of what the request actually called.
        expect(capabilitiesFor([call('Email/query')])).not.toContain(CONTACTS);
    });
});

describe('envelope', () => {
    it('always includes core, which defines the request itself', () => {
        expect(capabilitiesFor([call('Email/get')])).toContain(CORE);
        expect(capabilitiesFor([])).toEqual([CORE]);
    });

    it('deduplicates when several calls share a capability', () => {
        const using = capabilitiesFor([call('Email/query'), call('Email/get'), call('Mailbox/get')]);

        expect(using.filter((c) => c === MAIL)).toHaveLength(1);
    });

    it('contributes nothing for an unknown type, so one call fails and not the batch', () => {
        // unknownMethod for that call beats unknownCapability for the request.
        expect(capabilitiesFor([call('Nonsense/get')])).toEqual([CORE]);
    });
});
