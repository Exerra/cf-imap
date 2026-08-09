# cf-imap

<picture><source media="(prefers-color-scheme: dark)" srcset="https://www.shieldcn.dev/badge/Stack-Cloudflare_Workers-F38020.svg?logo=cloudflare&amp;variant=branded&amp;size=sm&amp;mode=dark&amp;label=+"><img alt="Cloudflare Workers" src="https://www.shieldcn.dev/badge/Stack-Cloudflare_Workers-F38020.svg?logo=cloudflare&amp;variant=branded&amp;size=sm&amp;mode=light&amp;label=+"></picture>
<picture><source media="(prefers-color-scheme: dark)" srcset="https://www.shieldcn.dev/github/license/Exerra/cf-imap.svg?variant=secondary&amp;size=sm&amp;mode=dark"><img alt="License" src="https://www.shieldcn.dev/github/license/Exerra/cf-imap.svg?variant=secondary&amp;size=sm&amp;mode=light"></picture>

IMAP (v4) client for the Cloudflare Workers platform. Do not try to run this on other runtimes, it will not work.

## Initialisation

The `CFImap` class can be created in any part of the code, **however it is advised to use the `connect()` function only in a request handler**. That is because the Cloudflare Workers platform limits some functionality (mainly `await`) outside of handlers.

```ts
import { CFImap } from "cf-imap"

const imap = new CFImap({
    host: "mail.example.com",
    port: 993,
    tls: true,
    auth: {
        username: "user@example.com",
        password: "pa$$w0rd"
    }
})

const handleRequest = async () => {
    await imap.connect()
    // ... use the imap instance
    await imap.logout()
}
```

## Usage

```ts
// Namespaces (personal/other/shared prefixes and delimiters)
const { personal } = await imap.getNamespaces()

// Folders
const folders = await imap.getFolders(personal[0]?.prefix ?? "", "*")

// Select a folder (returns mailbox info: EXISTS, recent, uidNext, uidValidity, flags, ...)
const mailbox = await imap.selectFolder("INBOX")

// Search: returns sequence numbers (UIDs with useUid: true)
const ids = await imap.searchEmails({ subject: "hello", seen: false })
const uids = await imap.searchEmails({ all: true, useUid: true })

// Fetch: full messages with parsed MIME (body text/html, attachments), or headers-only
const emails = await imap.fetchEmails({ limit: [1, 10], fetchBody: true })
const headersOnly = await imap.fetchEmails({ limit: [1, 10], fetchBody: false })

// Flags, copy, move, expunge, status, append
await imap.storeFlags("1:5", ["Seen"], "add") // add | remove | replace
await imap.copy("INBOX/archive", "1:5") // returns COPYUID mapping when available
await imap.move("INBOX/archive", "1:5", true) // useUid
await imap.expunge({ range: "1:10", useUid: true })
const status = await imap.status("INBOX")
await imap.append("INBOX", rawMessage, ["Seen"]) // returns APPENDUID when available

// Mailbox lifecycle
await imap.examine("INBOX") // read-only select
await imap.closeMailbox() // CLOSE: expunges \Deleted then deselects
await imap.unselect() // UNSELECT: deselect without expunging

// IDLE: push updates; return false from the callback to stop
await imap.idle((item) => {
    console.log(item.line) // "* 5 EXISTS", "* 2 EXPUNGE", ...
    // return false to leave IDLE
})
```

### RFC 9051 (IMAP4rev2) compliance

- **TLS**: `tls: true` on port 993 uses Implicit TLS (RFC 8314); other ports use the
  `STARTTLS` command (RFC 9051 §6.2.1) and re-issue `CAPABILITY` after upgrading.
- **Authentication**: `AUTHENTICATE PLAIN` with a SASL initial response is tried first;
  `LOGIN` is only used as a last resort and never when the server advertises
  `LOGINDISABLED` (RFC 9051 §6.2.2/§6.2.3).
- **IMAP4rev2 negotiation**: `ENABLE IMAP4rev2` is issued automatically when a server
  advertises both `IMAP4rev1` and `IMAP4rev2` (RFC 9051 Appendix A).
- **Search**: parses both `* SEARCH` (IMAP4rev1) and `* ESEARCH` (IMAP4rev2) responses;
  non-ASCII queries get `CHARSET UTF-8`.
- **Mailbox names**: UTF-8 (Net-Unicode) on IMAP4rev2 sessions; automatically converted
  to/from modified UTF-7 (RFC 2152) on IMAP4rev1-only servers.
- `check()` was removed from IMAP4rev2 and is refused on rev2 sessions — use `NOOP`/`IDLE`.
- The deprecated `\Recent`/`NEW`/`OLD`/`RECENT` search keys still work against
  IMAP4rev1 servers but are not part of IMAP4rev2.

### Email object

```ts
{
  uid, seq, flags, internalDate, size,
  from: string[], to: string[], cc: string[],
  subject, messageID, contentType,
  headers: Record<string, string>, // decoded + unfolded
  rawHeaders: string,
  body: { text?: string, html?: string, raw: string },
  attachments: [{ filename, mimeType, size, encoding, content, contentBase64, contentId?, isInline }],
  raw: string
}
```

### Error handling

Failed commands throw `ImapError` (an `Error` subclass with `status`, `tag`, `messageText` and `untagged` response items). Read timeouts and connection drops throw regular `Error`s. Configure the read timeout via the `timeoutMs` option (default 30000).

## Logging out

The `logout()` function (alias: `close()`) logs out of the session and closes the socket. It is recommended to use this as to not run the Worker needlessly (some providers auto-kick you after a while, some keep the connection open indefinitely).

```ts
await imap.logout()
```

## Documentation

Documentation can be found [here](https://docs.exerra.xyz/docs/npm-packages/cf-imap/v1.0.0/intro).
