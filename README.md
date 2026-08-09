# cf-imap

IMAP (v4) client for the Cloudflare Workers platform. Do not try to run this on other runtimes, it will not work.

Warning, this version is **pre-release**, so breaking changes **may** happen between versions.

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
await imap.copy("INBOX/archive", "1:5")
await imap.move("INBOX/archive", "1:5", true) // useUid
await imap.expunge({ range: "1:10", useUid: true })
const status = await imap.status("INBOX")
await imap.append("INBOX", rawMessage, ["Seen"])
```

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

Documentation can be found [here](https://docs.exerra.xyz/docs/npm-packages/cf-imap/v0.x.x/intro).
