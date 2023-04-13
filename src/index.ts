import {Command, flags} from '@oclif/command'
import cli from 'cli-ux'
import {addConfigToGitignore, getConfig, parseValue, writeConfig} from './utils'

const axios = require('axios').default
const fs = require('fs').promises
const filesystem = require('fs')
const path = require('path')
const process = require('process')
const ProgressBar = require('progress')
const crypto = require('crypto');
const Multiprogress = require('multi-progress');

interface Variable {
    key: string
    latest_version: {
        id: bigint
        value: string
    }
}

class Envault extends Command {
    static description = 'Sync your .env file with Envault.'

    static flags = {
        constructive: flags.boolean({
            char: 'c',
            description: 'enable prompts to create missing variables',
        }),
        filename: flags.string({description: 'name of .env file'}),
        force: flags.boolean({description: 'accept all prompts'}),
        help: flags.help({char: 'h'}),
        forceDownload: flags.boolean({description: 'force download files and overwrite local files'}),
        version: flags.version({char: 'v'}),
    }

    static args = [
        {
            name: 'server',
            hidden: true,
        },
        {
            name: 'environment',
            hidden: true,
        },
        {
            name: 'token',
            hidden: true,
        },
    ]
    private secureFilesDir: string = '.secure_files';

    private multiProgress = new Multiprogress(process.stdout);

    private md5File(filePath: string) {
        return new Promise((resolve, reject) => {
            // Create a read stream from the file
            const stream = filesystem.createReadStream(filePath);

            // Create the MD5 hash object
            const hash = crypto.createHash('md5');

            // Handle errors on the stream
            stream.on('error', (error: any) => {
                reject(error);
            });

            // Update the hash with data from the stream
            stream.on('data', (chunk: any) => {
                hash.update(chunk);
            });

            // Handle the end of the stream
            stream.on('end', () => {
                // Get the final hash value as a hex string
                const result = hash.digest('hex');
                resolve(result);
            });
        });
    }

    private deleteFilesInDirectory(dirPath: any, serverFiles: any) {
        const serverFileNames = serverFiles.map((file: any) => file.name);
        const files = filesystem.readdirSync(dirPath);

        files.forEach((file: any) => {
            const filePath = path.join(dirPath, file);

            // Check if the file is a directory
            if (filesystem.statSync(filePath).isDirectory()) {
                // Recursively call this function on the subdirectory
                this.deleteFilesInDirectory(filePath, serverFiles);
            } else {
                if (!serverFileNames.includes(file)) {
                    // Delete the file
                    filesystem.unlinkSync(filePath);
                }
            }
        });
    }

    async processSecureFiles(files: object[], server: string, environment: string, token: string) {
        const {args, flags} = this.parse(Envault)

        this.log('Deleting files which not exists on the server...')
        this.deleteFilesInDirectory(this.secureFilesDir, files);

        this.log('Downloading files...')

        const promises = files.map(async (file: any) => {
            const path = `${this.secureFilesDir}/${file.name}`
            const localFileExists = filesystem.existsSync(path);
            const existsFileMd5 = localFileExists ? await this.md5File(path) : null;
            const isFilesEqual = existsFileMd5 === file.md5;

            if (!isFilesEqual || !localFileExists || flags.forceDownload) {
                const url = `https://${server}/api/v1/apps/${environment}/download/${token}/file/${file.uuid}`;
                const {data, headers} = await axios.get(url, {responseType: 'stream'});

                // Get the total file size from the Content-Length header
                const totalSize = parseInt(headers['content-length'], 10);

                // Create a progress bar for each file
                const fileBar = this.multiProgress.newBar(`[:bar] :percent :etas`, {
                    complete: '=',
                    incomplete: ' ',
                    width: 40,
                    total: totalSize
                });

                // Write the file to disk as it downloads
                const writer = filesystem.createWriteStream(path);
                data.on('data', (chunk: string | any[]) => {
                    fileBar.tick(chunk.length);
                    writer.write(chunk);
                });

                // Return a promise that resolves when the file has finished downloading
                return new Promise((resolve, reject) => {
                    data.on('end', () => {
                        writer.end();
                        resolve();
                    });
                    data.on('error', reject);
                });
            } else {
                this.log(`MD5 for the local file ${file.name} the same as servers file MD5. Skip downloading.`)
                return Promise.resolve(); // return a resolved promise for skipped files
            }
        });

        await Promise.all(promises);
        this.log('All files downloaded successfully!');
    }

    async run() {
        const {args, flags} = this.parse(Envault)

        this.log('Welcome to Envault! No more .env update nightmares from now on, we promise 🤗')

        if (args.server && args.environment && args.token) {
            let environment = args.environment
            let filename = flags.filename ?? '.env'
            let server = args.server
            let token = args.token

            cli.action.start('Connecting to your Envault server')

            let response

            try {
                response = await axios.post(`https://${server}/api/v1/apps/${environment}/setup/${token}`)
            } catch (error) {
                this.error('Looks like your setup token is invalid, please get another!')

                return
            }

            cli.action.stop()

            if (!response.data.authToken) return

            // Process secure files
            if (!filesystem.existsSync(this.secureFilesDir)) {
                filesystem.mkdirSync(this.secureFilesDir)
            }

            if (filesystem.readdirSync(this.secureFilesDir).length > 0) {
                if (!flags.force && !await cli.confirm(`Directory ${this.secureFilesDir} is not empty! If you continue, all files in this directory will be replaced server files. Continue? Y/n`)) {
                    this.warn(`File synchronization aborted as a ${this.secureFilesDir} directory exists.`)
                } else {
                    await this.processSecureFiles(response.data.app.files, server, environment, token)
                }
            } else {
                await this.processSecureFiles(response.data.app.files, server, environment, token)
            }

            const variables: Array<Variable> = response.data.app.variables

            let contents = ''

            try {
                contents = (await fs.readFile(filename)).toString()
            } catch (error) {
                if (!flags.force && !await cli.confirm(`A ${filename} file was not found. Would you like to create a new one? Y/n`)) return this.error(`Initialization aborted as a ${filename} file was not found.`)

                for (const variable of variables) {
                    contents += `${variable.key}=\n`
                }

                await fs.writeFile(filename, contents)
            }

            await writeConfig({
                authToken: response.data.authToken,
                environment: environment,
                filename: filename,
                server: server,
            })

            this.log('Configuration file set up.')

            if (await addConfigToGitignore()) this.log('.gitignore updated.')

            const localVariables = require('dotenv').config({path: path.resolve(process.cwd(), filename)}).parsed

            let updates: Array<Variable> = []

            for (const variable of variables) {
                if (!(variable.key in localVariables)) {
                    if (!flags.constructive) continue

                    if (!flags.force && !await cli.confirm(`The ${variable.key} variable is not currently present in your ${filename} file. Would you like to add it? Y/n`)) continue
                }

                if (localVariables[variable.key] === parseValue(variable.latest_version.value)) continue

                let expression = new RegExp('^' + variable.key + '=.*', 'gm')

                contents = contents.replace(expression, `${variable.key}=${variable.latest_version.value}`)

                if (!contents.match(expression)) {
                    contents += `\n${variable.key}=${variable.latest_version.value}\n`
                }

                updates.push(variable)
            }

            await fs.writeFile(filename, contents)

            if (updates.length) {
                this.log(`We updated ${updates.length} ${updates.length > 1 ? 'variables' : 'variable'}:`)

                let updatesTree = cli.tree()

                for (const variable of updates) {
                    updatesTree.insert(`${variable.key} to v${variable.latest_version.id}`)
                }

                updatesTree.display()

                return
            }

            this.log('You are already up to date 🎉')

            return
        }

        const config = await getConfig(args.server, args.environment)

        if (!config) this.error('Please initialize your Envault environment before trying to pull.')

        let authToken = config.authToken
        let environment = config.environment
        let filename = flags.filename ?? config.filename ?? '.env'
        let server = config.server

        cli.action.start('Connecting to your Envault server')

        axios.defaults.headers.common['Authorization'] = `Bearer ${authToken}`

        let response

        try {
            response = await axios.post(`https://${server}/api/v1/apps/${environment}/update`)
        } catch (error) {
            this.error('There is an error with your Envault configuration, please set up your app again!')

            return
        }

        cli.action.stop()

        const variables: Array<Variable> = response.data.variables

        let contents = ''

        try {
            contents = (await fs.readFile(filename)).toString()
        } catch (error) {
            if (!flags.force && !await cli.confirm(`A ${filename} file was not found. Would you like to create a new one? Y/n`)) return this.error(`Pull aborted as a ${filename} file was not found.`)

            for (const variable of variables) {
                contents += `${variable.key}=\n`
            }

            await fs.writeFile(filename, contents)
        }

        const localVariables = require('dotenv').config({path: path.resolve(process.cwd(), filename)}).parsed

        let updates: Array<Variable> = []

        for (const variable of variables) {
            if (!(variable.key in localVariables)) {
                if (!flags.constructive) continue

                if (!flags.force && !await cli.confirm(`The ${variable.key} variable is not currently present in your ${filename} file. Would you like to add it? Y/n`)) continue
            }

            if (localVariables[variable.key] === parseValue(variable.latest_version.value)) continue

            let expression = new RegExp('^' + variable.key + '=.*', 'gm')

            contents = contents.replace(expression, `${variable.key}=${variable.latest_version.value}`)

            if (!contents.match(expression)) {
                contents += `\n${variable.key}=${variable.latest_version.value}\n`
            }

            updates.push(variable)
        }

        await fs.writeFile(filename, contents)

        if (updates.length) {
            this.log(`We updated ${updates.length} ${updates.length > 1 ? 'variables' : 'variable'}:`)

            let updatesTree = cli.tree()

            for (const variable of updates) {
                updatesTree.insert(`${variable.key} to v${variable.latest_version.id}`)
            }

            updatesTree.display()

            return
        }

        this.log('You are already up to date 🎉')
    }
}

export = Envault
