#! /usr/bin/env node

import { Command as Commander, InvalidArgumentError } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import searchList from 'inquirer-search-list';
import { translate } from '@vitalets/google-translate-api';
import fuzzy from 'inquirer-fuzzy-path';
import ObjectManager from 'object.mn';
import { readFile, writeFile } from 'node:fs/promises';
import open from 'open';
import { isFile } from 'bucky.js';
import pkg from './package.json';
import { Database } from 'bucky.db-local';

class Translate extends Commander {
    public db: Database;
    public fileTypes: string[];

    constructor() {
        super();

        inquirer.registerPrompt('search-list', searchList);
        inquirer.registerPrompt('path', fuzzy);

        this.db = new Database({});
        this.fileTypes = ['.json', '.txt'];

        super
            .name(pkg.name)
            .description(pkg.description)
            .version(pkg.version);

        super
            .argument('[message...]', 'message to be translated')
            .option('-t, --to <language>', 'translate to the language you want', this.verifyString.bind(this))
            .option('-l, --languages', 'languages available for translation');

        super
            .command('to')
            .description('defines a default language to be translated')
            .action(this.to.bind(this));

        super
            .command('file')
            .description('use to translate texts in your files')
            .action(this.translateFile.bind(this))

        super
            .command('web')
            .description('google translator website')
            .action(async() => await open('https://translate.google.com/') as any)

        super.action(this.run.bind(this));
    }

    async run(message: string[], options: OptionsCommand, command: this) {
        if (options?.languages) {
            return console.log(
                chalk.bold.white('Available languages:'),
                '\n' + chalk.bold.gray((await this.languages()).join('\n'))
            );
        }

        if (!message?.length && !Object.keys(options).length) throw new InvalidArgumentError('You have not defined any valid arguments!');
        if (!message?.length && options?.to) throw new InvalidArgumentError('For you to translate to a specific language, first inform the message!');

        return this.translate(message, (options.to ?? this.db.get('defaultLanguage')) ?? 'en');
    }

    async translate(message: string[], to: string) {
        try {
            const { text } = await translate(message.join(' '), { to });
            return console.log(chalk.green('>') + chalk.bold.white(` Translation: ${text}`));
        } catch(error: any) {
            throw new Error(error);
        }
    }

    async translateFile() {
        const { path } = await inquirer.prompt([{
            type: 'path',
            name: 'path',
            message: 'select file path:',
            itemType: 'file',
            depthLimit: 5,

            excludeFilter: (nodePath: string) => {
                if (nodePath.startsWith('.')) return true;

                const pathSplit = nodePath.split('/');
                if (pathSplit.some(path => /^\.[A-z]/.test(path))) return true;
                if (nodePath.includes('node_modules')) return true;

                let fileType = /\.([^./]+)$/.exec(nodePath);
                if (fileType && this.fileTypes.includes(fileType![0])) return false;

                return true;
            }
        }]);

        if (!isFile(path)) return console.log(chalk.red('!') + chalk.bold.red(' File not found!'));
        switch((path.split('/').at(-1))?.split('.').pop()) {
            case 'json':
                try {
                    const data = JSON.parse(await readFile(path, 'utf8')),
                        messages = await resolveMessages(),
                        pathTranslated = (path.split('/').at(-1))?.split('.')[0] + '-translated.json',
                        message = messages.map(({ text }, index) => `${index}==${JSON.stringify(text)}`).join('//');
                                
                    async function resolveMessages() {
                        let messages = [];
                    
                        function resolvePaths(obj: object, currentPath?: string) {
                            return new Promise(async(resolve, reject) => {
                                for (let [key, value] of Object.entries(obj)) {
                                    if (typeof value == 'string' || Array.isArray(value)) {
                                        if (!value.length) continue;
                    
                                        messages.push({
                                            path: currentPath ? currentPath + '/' + key : key,
                                            text: value
                                        } as never);
                                        continue;
                                    }
                    
                                    if (isObject(value) && Object.keys(value).length)
                                        resolvePaths(value, currentPath ? currentPath + '/' + key : key);
                                }
                    
                                return resolve(true);
                            });
                        }
                    
                        function isObject(content: any) {
                            return !Array.isArray(content) && typeof content === 'object' && content !== null;
                        }
                    
                        await resolvePaths(data);
                        return messages;
                    }

                    const { text } = await translate(message, { to: this.db.get('defaultLanguage') ?? 'en' }),
                        newMessages = text.split('//').map(message => message.split('==')),
                        objectMessages = new ObjectManager({});

                    for (let [index, value] of newMessages) objectMessages.set(messages[index].path, JSON.parse(value));
                    await writeFile(pathTranslated, JSON.stringify(objectMessages.objectData, null, 4));
                    return console.log(
                        chalk.green('!') +
                        chalk.bold.white(` Translation completed successfully, path: `) +
                        chalk.bold.gray(pathTranslated));
                } catch(error: any) {
                    throw new Error(error);
                }
                break;

            case 'txt':
                try {
                    const content = await readFile(path, 'utf8'),
                        { text } = await translate(content, { to: this.db.get('defaultLanguage') ?? 'en' }),
                        pathTranslated = (path.split('/').at(-1))?.split('.')[0] + '-translated.txt';

                    await writeFile(pathTranslated, text);
                    return console.log(
                        chalk.green('!') +
                        chalk.bold.white(` Translation completed successfully, path: `) +
                        chalk.bold.gray(pathTranslated));
                } catch(error: any) {
                    throw new Error(error);
                }
                break;
        }
    }

    async to() {
        const { language } = await inquirer.prompt([{
            type: 'search-list',
            name: 'language',
            message: 'Choose which default language you want to use for translations:',
            choices: await this.languages()
        }]);

        this.db.set('defaultLanguage', language);
        return console.log(chalk.green('!') + chalk.bold.white(` The chosen language (${language}) has been set as default in translations.`));
    }

    async languages() {
        const longNames = this.db.entries('languages/longName'),
            shortNames = this.db.get('languages/shortName'),
            languages: string[] = [];

        for (let [index, language] of longNames) languages.push(`  ${language} (${shortNames[index]})`);
        return languages;
    }

    verifyString(value: any) {
        if (typeof value != 'string') throw new InvalidArgumentError('The value has to be a string!');
        if (
            !this.db.get('languages/longName').includes(value) &&
            !this.db.get('languages/shortName').includes(value)
        ) throw new InvalidArgumentError('You provided a non-existent language, use --languages to see available languages');

        return value;
    }
}

new Translate().parse(process.argv);

interface OptionsCommand {
    from: string;
    to: string;
    languages: boolean;
}