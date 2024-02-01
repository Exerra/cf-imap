# cf-imap

IMAP (v4) client for the Cloudflare Workers platform. Do not try to run this on other runtimes, it will not work.

Warning, this version is **pre-release**, so breaking changes **may** happen between versions. At this stage for existing functions it is unlikely, however the possibility still exists.

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
}
```

## Logging out

The `logout()` function lets you log out of the session and close the socket. It is recommended to use this as to not run the Worker needlessly (some providers auto-kick you after a while, some keep the connection open indefinitely).

```ts
await imap.logout()
```

## Documentation

Documentation can be found [here](https://docs.exerra.xyz/docs/npm-packages/cf-imap/v0.x.x/intro).
