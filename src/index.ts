import { connect } from "cloudflare:sockets";
import type { Email, FetchEmailsProps } from "./types/emails";

type Options = {
    host: string,
    port: number,
    tls: boolean,
    auth: {
        username: string,
        password: string
    }
}

export class CFImap {
    options = {
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

    socket: ReturnType<typeof connect> | null = null

    // TODO: docs (not that necessary, but nice to have)
    session: { id?: string, protocol?: string } = {}

    selectedFolder = ""

    private encoder = new TextEncoder()
    private decoder = new TextDecoder()

    private writer: WritableStreamDefaultWriter<any> | null = null
    private reader: ReadableStreamDefaultReader<any> | null = null

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

        const encoded = this.encoder.encode(`A1 login ${this.options.auth.username} ${this.options.auth.password}\n`)

        await this.writer.write(encoded)

        let returnvalue = await this.decoder.decode((await this.reader.read()).value)

        // ? Have to test with slow IMAP servers, the speed at which this grabs the read data might be too fast for some.
        if (!returnvalue.startsWith("A1 OK")) throw new Error("A1 netiek atgriezts")

        let regex = /^A1 OK \[CAPABILITY (\w{1,}) .{2,}(?=])\] User logged in SESSIONID=<(.{1,}(?=>))>/.exec(returnvalue)

        if (regex) {
            this.session = {
                id: regex[2],
                protocol: regex[1]
            }
        }

        return

    }

    /**
     * Returns the prefix and hierarchy delimiter to personal and shared namespaces that the logged in user has access to. Should be the second ran function.
     */
    getNamespaces = async () => {
        if (!this.socket || !this.reader || !this.writer) throw new Error("Not connected to an IMAP server")

        let encoded = await this.encoder.encode("n namespace\n")

        await this.writer.write(encoded)

        let decoded = await this.decoder.decode((await this.reader.read()).value)

        let regex = new RegExp(/\* NAMESPACE \(\((.{1,})\)\) (.{1,}) (.{1,})/)

        let splitDecoded = decoded.split("\r\n")

        if (splitDecoded.length === 0) throw new Error("Namespaces empty")

        let regexExec = regex.exec(splitDecoded[0])

        if (!regexExec) throw new Error("Namespaces - regex issue")

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

        let encoded = await this.encoder.encode(`A1 list "${namespace}" "${filter}"\n`)

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

        await this.writer.write(await this.encoder.encode(`g21 SELECT "${folder}"\n`))

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

        let query = `A5 FETCH ${limit.join(":")} (BODY${peek ? ".PEEK" : ""}[TEXT] BODY${peek ? ".PEEK" : ""}[HEADER.FIELDS (SUBJECT FROM TO MESSAGE-ID CONTENT-TYPE DATE)]${byteLimit ?  `<${byteLimit}>` : ""})\n`

        let encoded = await this.encoder.encode(query)

        await this.writer.write(encoded)
        
        let decoded = await this.decoder.decode((await this.reader.read()).value)

        let responses = decoded.split("\r\n")

        // With large data the server might still be streaming data when we grab it from the TCP stream, This basically ensures that we get to the very end.
        const timeout = async (): Promise<boolean> => {
            // ! Might fail when the response is a failure, might need error checking for that 
            // @ts-ignore findLastIndex exists on string[], however the tsc compiler thinks it doesn't
            if (responses.findLastIndex(r => r.startsWith("A5 OK Completed")) == -1) {
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
     * Requests a "checkpoint" on the server, a.k.a requests that the server does some houskeeping.
     * Almost never used, but exists in the RFC 3501 spec.
     */
    check = async () => {
        if (!this.socket || !this.reader || !this.writer) throw new Error("Not initialised")

        let query = `FXXZ CHECK\n`

        let encoded = await this.encoder.encode(query)

        await this.writer.write(encoded)

        let decoded = await this.decoder.decode((await this.reader.read()).value)

        let responses = decoded.split("\r\n")

        return responses
    }
}

