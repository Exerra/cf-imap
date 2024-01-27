# cf-imap

IMAP (v4) client for the Cloudflare Workers platform. Do not try to run this on other runtimes, it will not work.

Warning, this version is **pre-release**, so expect breaking changes **may** happen between versions. At this stage for existing functions it is unlikely, however the possibility still exists.

# Initialisation

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

## Documentation

Documentation can be found [here](https://docs.exerra.xyz/docs/npm-packages/cf-imap/v0.x.x/intro).
