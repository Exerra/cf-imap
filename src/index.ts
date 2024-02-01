import { connect } from "cloudflare:sockets";
import type { Email, FetchEmailsProps, SearchEmailsProps } from "./types/emails";

type Options = {
    host: string,
    port: number,
    tls: boolean,
    auth: {
        username: string,
        password: string
    }
}

// TODO: Add documentation when version is 1.x.x
export class CFImap {
    private options = {
        host: "",
        port: NaN,
        tls: false,
        auth: {
            username: "",
            password: ""
        }
    } as Options

    constructor({ host, port, tls, auth }: Options) {
        this.options = {
            host,
            port,
            tls,
            auth
        }
    }

    /**
     * Raw socket used to communicate with the IMAP server. Null if connect function not run yet.
     */
    socket: ReturnType<typeof connect> | null = null

    // TODO: docs (not that necessary, but nice to have)
    // ? console log a warning on each function if protocol not imapv4?
    session: { id?: string, protocol?: string } = {}

    /**
     * Only used to determine if a folder is selected
     */
    selectedFolder = ""

    encoder = new TextEncoder()
    decoder = new TextDecoder()

    writer: WritableStreamDefaultWriter<any> | null = null
    reader: ReadableStreamDefaultReader<any> | null = null

    /**
     * Connects to the IMAP server. Must be run after initialising the CFImap class, otherwise nothing will work.
     * 
     * @async
     * @returns {void}
     */
    connect = async () => {
        let options: SocketOptions = {
            allowHalfOpen: true
        }

        if (this.options.tls) options.secureTransport = "starttls"

        this.socket = await connect({ hostname: this.options.host, port: this.options.port }, options)

        if (this.options.tls) {
            const secureSocket = this.socket.startTls()

            this.socket = secureSocket
        }


        this.writer = this.socket.writable.getWriter()
        this.reader = this.socket.readable.getReader()

        let chunks: string[] = []

        await this.decoder.decode((await this.reader.read()).value)

        const encoded = this.encoder.encode(`A1 login ${this.options.auth.username} ${this.options.auth.password}\r\n`)

        await this.writer.write(encoded)

        let returnvalue = await this.decoder.decode((await this.reader.read()).value)

        let responses = await returnvalue.split("\r\n")

        // ? Have to test with slow IMAP servers, the speed at which this grabs the read data might be too fast for some.
        if (!responses[responses.length - 2].startsWith("A1 OK")) throw new Error("IMAP server not responding with an A1 OK.", { cause: responses })

        if (responses.find(r => r.startsWith("* CAPABILITY")) != undefined) {
            let regex = /^\* CAPABILITY (\w{1,}) .{2,}/.exec(responses[0])

            if (regex) {
                this.session = {
                    protocol: regex[1]
                }
            }   
        } else {
            let regex = /^A1 OK \[CAPABILITY (\w{1,}) .{2,}(?=])\] User logged in SESSIONID=<(.{1,}(?=>))>/.exec(responses[0])

            if (regex) {
                this.session = {
                    id: regex[2],
                    protocol: regex[1]
                }
            }
        }

        return

    }

    /**
     * Returns the prefix and hierarchy delimiter to personal and shared namespaces that the logged in user has access to. Should be the second ran function.
     */
    getNamespaces = async () => {
        if (!this.socket || !this.reader || !this.writer) throw new Error("Not connected to an IMAP server")

        let encoded = await this.encoder.encode("n namespace\r\n")

        await this.writer.write(encoded)

        let decoded = await this.decoder.decode((await this.reader.read()).value)

        let regex = new RegExp(/\* NAMESPACE \(\((.{1,})\)\) (.{1,}) (.{1,})/)

        let splitDecoded = decoded.split("\r\n")

        if (splitDecoded.length === 0) throw new Error("Namespaces empty", { cause: splitDecoded })

        let regexExec = regex.exec(splitDecoded[0])

        if (!regexExec) throw new Error("Namespaces - regex issue. If you believe this to be a bug, please report it.", { cause: { response: splitDecoded[0], regex } })

        let namespaces: string[] = []

        namespaces.push(regexExec[1].split(" ")[0].replaceAll(`"`, ""))

        return namespaces
    }

    /**
     * Returns all folders in the specified namespace along with any flags.
     * @param {string} namespace - From which namespace to list folders
     * @param {string} filter - String filter
     */
    getFolders = async (namespace: string, filter = "*") => {
        if (!this.socket || !this.reader || !this.writer) throw new Error("Not connected to an IMAP server")

        let encoded = await this.encoder.encode(`A1 list "${namespace}" "${filter}"\r\n`)

        await this.writer.write(encoded)

        let decoded = await this.decoder.decode((await this.reader.read()).value)

        let responses = decoded.split("\r\n")

        let folders: Array<{ name: string, delimiter: string, attributes: string[] }> = []

        let regex = new RegExp(/\* LIST \((?<attributes>.{1,})\) (?<delimiter>.{1,}) (?<name>.{1,})/)

        for (const response of responses) {
            let exec = regex.exec(response)

            if (!exec?.groups) continue

            let attributes = exec?.groups.attributes.split("\\").filter(attr => attr !== "")

            for (let i in attributes) {
                attributes[i] = attributes[i].trim()
            }

            folders.push({
                name: exec?.groups.name.trim(),
                delimiter: exec?.groups.delimiter.trim(),
                attributes: attributes
            })
        }

        return folders
    }

    /**
     * Selects a folder for use in the email GET & FETCH functions. Must be run before those commands, otherwise those commands will throw an error.
     * @param folder - Selectable folder
     */
    selectFolder = async (folder: string) => {
        if (!this.socket || !this.reader || !this.writer) throw new Error("Not initialised")

        if (!folder) throw new Error("Folder not given")

        await this.writer.write(await this.encoder.encode(`g21 SELECT "${folder}"\r\n`))

        let decoded = await this.decoder.decode((await this.reader.read()).value)

        let responses = decoded.split("\r\n")

        let metadata: { [key: string]: any } = {}

        for (let response of responses) {
            if (response.startsWith("*")) response = response.replace("* ", "")

            if (response.endsWith("EXISTS")) metadata.emails = parseInt(response.split(" ")[0])

            if (response.endsWith("RECENT")) metadata.recent = parseInt(response.split(" ")[0])

            if (response.startsWith("FLAGS")) {
                let regex = new RegExp(/FLAGS \((?<flags>.{1,})\)/)

                let exec = regex.exec(response)

                if (!exec) continue
                if (!exec.groups) continue

                let flags = []

                for (let flag of exec.groups.flags.split(" ")) {
                    if (!flag.startsWith("\\")) continue

                    flags.push(flag.replace("\\", ""))
                }

                metadata.flags = flags
            }

            if (response.startsWith("OK")) {
                let regex = new RegExp(/OK \[(?<kv>.{1,})\] (?<status>.{1,})/)

                let exec = regex.exec(response)

                if (!exec) continue
                if (!exec.groups) continue

                let { kv, status } = exec.groups

                if (status != "Ok") continue

                if (kv.startsWith("PERMANENTFLAGS")) {
                    let flags = []

                    let flagExec = new RegExp(/PERMANENTFLAGS \((?<flags>.{1,})\)/).exec(kv)

                    if (!flagExec) continue
                    if (!flagExec.groups) continue

                    for (let flag of flagExec.groups.flags.split(" ")) {
                        if (!flag.startsWith("\\")) continue

                        flags.push(flag.replace("\\", ""))
                    }

                    metadata.permanentFlags = flags
                    continue
                }

                let split = kv.split(" ")

                try {
                    let parsed = parseInt(split[1])

                    if (isNaN(parsed)) metadata[split[0].toLowerCase()] = split[1]

                    metadata[split[0].toLowerCase()] = parsed
                } catch (e) {
                    throw new Error("Test")
                }
            }
        }

        this.selectedFolder = folder

        return metadata
    }

    /**
     * Fetches emails from a folder specified by the selectFolder() function.
     * 
     * @async
     * @param {Object} props - Props
     * @param {number} [props.byteLimit] - Maximum size of the emails to fetch (optional, not recommended)
     * @param {[ number, number ]} props.limit - Range of emails to fetch.
     * @param {boolean} [props.peek=true] - If true (optional, defaults to true), upon fetch the emails won't get the \Seen flag set.
     */
    fetchEmails = async ({ folder, byteLimit, limit, peek = true }: FetchEmailsProps) => {
        if (!this.socket || !this.reader || !this.writer) throw new Error("Not initialised")

        if (!this.selectedFolder) throw new Error("Folder not selected! Before running this function, run the selectFolder() function!")

        let query = `A5 FETCH ${limit.join(":")} (BODY${peek ? ".PEEK" : ""}[TEXT] BODY${peek ? ".PEEK" : ""}[HEADER.FIELDS (SUBJECT FROM TO MESSAGE-ID CONTENT-TYPE DATE)]${byteLimit ?  `<${byteLimit}>` : ""})\r\n`

        let encoded = await this.encoder.encode(query)

        await this.writer.write(encoded)
        
        let decoded = await this.decoder.decode((await this.reader.read()).value)

        let responses = decoded.split("\r\n")

        // With large data the server might still be streaming data when we grab it from the TCP stream, This basically ensures that we get to the very end.
        const timeout = async (): Promise<boolean> => {
            // ! Might fail when the response is a failure, might need error checking for that 
            // @ts-ignore findLastIndex exists on string[], however the tsc compiler thinks it doesn't
            if (responses.findLastIndex(r => r.startsWith("A5 OK")) == -1) {
                if (!this.reader) return false // mostly so it doesnt scream about this.reader being possibly undefined

                decoded = await this.decoder.decode((await this.reader.read()).value)

                responses = [...responses, ...decoded.split("\r\n")]

                return timeout()
            }

            return true
        }

        await timeout()

        let emails: Email[] = []
        let emailsRaw = [];
        let currentEmail = [];

        // Seperates the emails into seperate arrays
        for (let line of responses) {
            // "*" is sent by the server as a sort of "start section" kind of thing
            if (line.startsWith('*')) {
                if (currentEmail.length > 0) {
                    emailsRaw.push(currentEmail);
                    currentEmail = [];
                }
            }
            currentEmail.push(line);
        }

        if (currentEmail.length > 0) {
            emailsRaw.push(currentEmail);
        }

        for (let emailRaw of emailsRaw) {
            // ? Looks a bit ugly, might need to be improved (func that finds?)
            // ? headers field
            let email: Email = {
                from: emailRaw.find(r => r.toLowerCase().startsWith("from:"))?.slice("from: ".length).trim()!,
                to: emailRaw.find(r => r.toLowerCase().startsWith("to:"))?.slice("to: ".length).trim()!,
                subject: emailRaw.find(r => r.toLowerCase().startsWith("subject:"))?.slice("subject: ".length).trim()!,
                messageID: emailRaw.find(r => r.toLowerCase().startsWith("message-id:"))?.slice("message-id: ".length).trim()!,
                contentType: emailRaw.find(r => r.toLowerCase().startsWith("content-type:"))?.slice("content-type: ".length).trim()!,
                date: new Date(emailRaw.find(r => r.toLowerCase().startsWith("date:"))?.slice("date: ".length).trim() as string),
                raw: emailRaw.join("\n"),
                body: ""
            }

            let mutRaw = emailRaw

            // Removes the useless junk at the end of the response. Goes backwards (starts at the last element and works its way up)
            for (let i = mutRaw.length; i--; i < 0) {
                let el = mutRaw[i]

                if (el === "") {
                    mutRaw.pop()

                    continue
                }

                if (el.startsWith("A5")) {
                    mutRaw.pop()

                    continue
                }

                if (el === ")") {
                    mutRaw.pop()

                    continue
                }

                break
            }

            let bodyStartIndex = mutRaw.findIndex(r => r.trim().startsWith("BODY[TEXT]"))

            mutRaw.splice(0, bodyStartIndex + 1)

            email.body = mutRaw.join("\n")

            emails.push(email)
        }

        return emails
    }


    /**
     * Searches emails based on the props given.
     */
    searchEmails = async (props: SearchEmailsProps) => {
        if (!this.socket || !this.reader || !this.writer) throw new Error("Not initialised")

        if (!props) throw new Error("Props not given")

        if (Object.keys(props).length === 0) throw new Error("No search options given. You must specify at least one search option.")

        if (!this.selectedFolder) throw new Error("Folder not selected! Before running this function, run the selectFolder() function!")

        let unFlags = [
            "answered",
            "deleted",
            "draft",
            "flagged",
            "seen"
        ]

        let command = `A5 SEARCH`

        let options: string[] = []

        let keys = Object.keys(props)

        for (let key of keys) {
            // ! fix later!!!
            // @ts-ignore
            let value = props[key];

            switch (typeof value) {
                case "boolean":
                    if (value) options.push(key.toUpperCase())
                    else {
                        if (unFlags.includes(key)) options.push(`un${key}`.toUpperCase())
                    }
                    break;
                case "string":
                    options.push(`${key.toUpperCase()} ${value}`)
                    break;
                case "number":
                    options.push(`${key.replace("Than", "")} ${value.toString()}`.toUpperCase())
                    break;
                case "object":
                    if (Array.isArray(value)) {
                        let values = []

                        for (let v of value) {
                            values.push(`${v}`)
                        }

                        options.push(`${key.toUpperCase()} ${values.join("")}`)
                    }

                    else if (value instanceof Date && !isNaN(value.valueOf())) {
                        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                        const monthIndex = value.getMonth();

                        options.push(`${key.toUpperCase()} ${value.getDate()}-${monthNames[monthIndex]}-${value.getFullYear()}`)
                    }

                    else if (key == "header") {
                        options.push(`${key.toUpperCase()} ${value.key.toUpperCase()} "${value.value}"`)
                    }
                    break;
            }

            if (keys.includes("all") && props["all"] === true) {
                options = ["ALL"]
            }
        }

        let query = `${command} ${options.join(" ")}`

        await this.writer.write(await this.encoder.encode(query.trim() +  "\r\n"))

        let decoded = await this.decoder.decode((await this.reader.read()).value)

        let responses = decoded.split("\r\n")

        let ids: number[] = []

        for (let response of responses) {
            if (!response.startsWith("* SEARCH")) continue

            let temp = response.replace("* SEARCH", "").trim().split(" ")

            for (let t of temp) {
                if (t === "") continue

                ids.push(parseInt(t))
            }

            break;
        }

        return ids
    }

    /**
     * Requests a "checkpoint" on the server, a.k.a requests that the server does some houskeeping.
     * Almost never used, but exists in the RFC 3501 spec.
     * Removed in the RFC 9051 spec, however most providers still support it.
     */
    check = async () => {
        if (!this.socket || !this.reader || !this.writer) throw new Error("Not initialised")

        let query = `FXXZ CHECK\r\n`

        let encoded = await this.encoder.encode(query)

        await this.writer.write(encoded)

        let decoded = await this.decoder.decode((await this.reader.read()).value)

        let responses = decoded.split("\r\n")

        return responses
    }

    /**
     * Logs the user out of the IMAP session and closes the socket.
     */
    logout = async () => {
        if (!this.socket || !this.reader || !this.writer) throw new Error("Not initialised")

        let query = `A023 LOGOUT\r\n`

        let encoded = await this.encoder.encode(query)

        await this.writer.write(encoded)

        await this.socket.close() // The server should close it automatically, so this is more of a failsafe.

        return true
    }
}

