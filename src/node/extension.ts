/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as net from 'net';
import * as vscode from 'vscode';
import { spawn, spawnSync, exec } from 'child_process';
import { basename, join, isAbsolute, dirname } from 'path';
import * as nls from 'vscode-nls';
import * as fs from 'fs';

const localize = nls.config(process.env.VSCODE_NLS_CONFIG)();


export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(vscode.commands.registerCommand('extension.pickNodeProcess', () => pickProcess()));

	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.provideInitialConfigurations', () => createInitialConfigurations()));

	context.subscriptions.push(vscode.commands.registerCommand('extension.node-debug.startSession', config => startSession(config)));
}

export function deactivate() {
}

//---- extension.pickNodeProcess

interface ProcessItem extends vscode.QuickPickItem {
	pid: string;	// payload for the QuickPick UI
}

function pickProcess() {

	return listProcesses().then(items => {

		let options : vscode.QuickPickOptions = {
			placeHolder: localize('pickNodeProcess', "Pick the node.js or gulp process to attach to"),
			matchOnDescription: true,
			matchOnDetail: true
		};

		return vscode.window.showQuickPick(items, options).then(item => {
			return item ? item.pid : null;
		});
	});
}

function listProcesses() : Promise<ProcessItem[]> {

	return new Promise((resolve, reject) => {

		const NODE = new RegExp('^(?:node|iojs|gulp)$', 'i');

		if (process.platform === 'win32') {

			const CMD_PID = new RegExp('^(.+) ([0-9]+)$');
			const EXECUTABLE_ARGS = new RegExp('^(?:"([^"]+)"|([^ ]+))(?: (.+))?$');

			let stdout = '';
			let stderr = '';

			const cmd = spawn('cmd');

			cmd.stdout.on('data', data => {
				stdout += data.toString();
			});
			cmd.stderr.on('data', data => {
				stderr += data.toString();
			});

			cmd.on('exit', () => {

				if (stderr.length > 0) {
					reject(stderr);
				} else {
					const items : ProcessItem[]= [];

					const lines = stdout.split('\r\n');
					for (const line of lines) {
						const matches = CMD_PID.exec(line.trim());
						if (matches && matches.length === 3) {

							let cmd = matches[1].trim();
							const pid = matches[2];

							// remove leading device specifier
							if (cmd.indexOf('\\??\\') === 0) {
								cmd = cmd.replace('\\??\\', '');
							}

							let executable_path: string | undefined;
							let args : string;
							const matches2 = EXECUTABLE_ARGS.exec(cmd);
							if (matches2 && matches2.length >= 2) {
								if (matches2.length >= 3) {
									executable_path = matches2[1] || matches2[2];
								} else {
									executable_path = matches2[1];
								}
								if (matches2.length === 4) {
									args = matches2[3];
								}
							}

							if (executable_path) {

								const executable_name = basename(executable_path);
								if (!NODE.test(executable_name)) {
									continue;
								}

								items.push({
									label: executable_name,
									description: pid,
									detail: cmd,
									pid: pid
								});
							}
						}
					};

					resolve(items);
				}
			});

			cmd.stdin.write('wmic process get ProcessId,CommandLine \n');
			cmd.stdin.end();

		} else {	// OS X & Linux

			const PID_CMD = new RegExp('^\\s*([0-9]+)\\s+(.+)$');
			const MAC_APPS = new RegExp('^.*/(.*).(?:app|bundle)/Contents/.*$');

			exec('ps -ax -o pid=,command=', { maxBuffer: 1000*1024 }, (err, stdout, stderr) => {

				if (err || stderr) {
					reject(err || stderr.toString());
				} else {
					const items : ProcessItem[]= [];

					const lines = stdout.toString().split('\n');
					for (const line of lines) {

						const matches = PID_CMD.exec(line);
						if (matches && matches.length === 3) {

							const pid = matches[1];
							const cmd = matches[2];
							const parts = cmd.split(' '); // this will break paths with spaces
							const executable_path = parts[0];
							const executable_name = basename(executable_path);

							if (!NODE.test(executable_name)) {
								continue;
							}

							let application = cmd;
							// try to show the correct name for OS X applications and bundles
							const matches2 = MAC_APPS.exec(cmd);
							if (matches2 && matches2.length === 2) {
								application = matches2[1];
							} else {
								application = executable_name;
							}

							items.unshift({		// build up list reverted
								label: application,
								description: pid,
								detail: cmd,
								pid: pid
							});
						}
					}

					resolve(items);
				}
			});
		}
	});
}

//---- extension.node-debug.provideInitialConfigurations

/*
 * default configuration for node.js
 */
const initialConfigurations = [
	{
		type: 'node',
		request: 'launch',
		name: localize('node.launch.config.name', "Launch Program"),
		program: '${file}'
	},
	{
		type: 'node',
		request: 'attach',
		name: localize('node.attach.config.name', "Attach to Process"),
		address: 'localhost',
		port: 5858
	}
];

/**
 * returns an initial configuration json as a string
 */
function createInitialConfigurations(): string {

	let program = vscode.workspace.textDocuments.some(document => document.languageId === 'typescript') ? '${workspaceRoot}/app.ts' : undefined;

	if (vscode.workspace.rootPath) {
		program = guessProgramFromPackage(vscode.workspace.rootPath);
	}

	if (program) {
		initialConfigurations.forEach(config => {
			if (config['program']) {
				config['program'] = program;
			}
		});
	}
	if (vscode.workspace.textDocuments.some(document => document.languageId === 'typescript' || document.languageId === 'coffeescript')) {
		initialConfigurations.forEach(config => {
			config['outFiles'] = [];
		});
	}
	// Massage the configuration string, add an aditional tab and comment out processId.
	// Add an aditional empty line between attributes which the user should not edit.
	const configurationsMassaged = JSON.stringify(initialConfigurations, null, '\t').replace(',\n\t\t"processId', '\n\t\t//"processId')
		.split('\n').map(line => '\t' + line).join('\n').trim();

	return [
		'{',
		'\t// Use IntelliSense to learn about possible Node.js debug attributes.',
		'\t// Hover to view descriptions of existing attributes.',
		'\t// For more information, visit: https://go.microsoft.com/fwlink/?linkid=830387',
		'\t"version": "0.2.0",',
		'\t"configurations": ' + configurationsMassaged,
		'}'
	].join('\n');
}

/*
 * try to find the entry point ('main') from the package.json
 */
function guessProgramFromPackage(folderPath: string): string | undefined {

	let program: string | undefined;

	try {
		const packageJsonPath = join(folderPath, 'package.json');
		const jsonContent = fs.readFileSync(packageJsonPath, 'utf8');
		const jsonObject = JSON.parse(jsonContent);

		if (jsonObject.main) {
			program = jsonObject.main;
		} else if (jsonObject.scripts && typeof jsonObject.scripts.start === 'string') {
			// assume a start script of the form 'node server.js'
			program = (<string>jsonObject.scripts.start).split(' ').pop();
		}

		if (program) {
			program = isAbsolute(program) ? program : join('${workspaceRoot}', program);
		}

	} catch (error) {
		// silently ignore
	}

	return program;
}


//---- extension.node-debug.startSession

// For launch, use inspector protocol starting with v6.9 because it's stable after that version.
const InspectorMinNodeVersionLaunch = 60900;


/**
 * The result type of the startSession command.
 */
class StartSessionResult {
	status: 'ok' | 'initialConfiguration' | 'saveConfiguration';
	content?: string;	// launch.json content for 'save'
};

function startSession(config: any): StartSessionResult {

	if (Object.keys(config).length === 0) { // an empty config represents a missing launch.json

		config.type = 'node';
		config.name = 'Launch';
		config.request = 'launch';

		if (vscode.workspace.rootPath) {
			// folder case: try to find entry point in package.json

			config.program = guessProgramFromPackage(vscode.workspace.rootPath);
		}

		if (!config.program) {
			// 'no folder' case (or no program found)

			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'javascript') {
				config.program = editor.document.fileName;
			} else {
				return {
					status: 'initialConfiguration'	// let VS Code create an initial configuration
				};
			}
		}
	}

	// make sure that 'launch' configs have a 'cwd' attribute set
	if (config.request === 'launch' && !config.cwd) {
		if (vscode.workspace.rootPath) {
			config.cwd = vscode.workspace.rootPath;
		} else if (config.program) {
			// derive 'cwd' from 'program'
			config.cwd = dirname(config.program);
		}
	}

	// determine what protocol to use

	let fixConfig = Promise.resolve<any>();

	switch (config.protocol) {
		case 'legacy':
			config.type = 'node';
			break;
		case 'inspector':
			config.type = 'node2';
			break;
		case 'auto':
		default:
			config.type = 'node'; // default

			switch (config.request) {

				case 'attach':
					fixConfig = getProtocolForAttach(config).then(protocol => {
						if (protocol === 'inspector') {
							config.type = 'node2';
						}
					});
					break;

				case 'launch':
					if (config.runtimeExecutable) {
						log(localize('protocol.switch.runtime.set', "Debugging with legacy protocol because a runtime executable is set."));
					} else {
						// only determine version if no runtimeExecutable is set (and 'node' on PATH is used)
						const result = spawnSync('node', [ '--version' ]);
						const semVerString = result.stdout.toString();
						if (semVerString) {
							if (semVerStringToInt(semVerString) >= InspectorMinNodeVersionLaunch) {
								config.type = 'node2';
								log(localize('protocol.switch.inspector.version', "Debugging with inspector protocol because Node {0} was detected.", semVerString.trim()));
							} else {
								log(localize('protocol.switch.legacy.version', "Debugging with legacy protocol because Node {0} was detected.", semVerString.trim()));
							}
						} else {
							log(localize('protocol.switch.unknown.version', "Debugging with legacy protocol because Node version could not be determined."));
						}
					}
					break;

				default:
					// should not happen
					break;
			}
			break;
	}

	fixConfig.then(() => {
		vscode.commands.executeCommand('vscode.startDebug', config);
	});

	return {
		status: 'ok'
	};
}

function log(message: string) {
	vscode.commands.executeCommand('debug.logToDebugConsole', message);
}

function getProtocolForAttach(config: any): Promise<string|undefined> {
	const address = config.address || '127.0.0.1';
	const port = config.port || 9229;

	const unknownProtocolMessage = localize('protocol.switch.unknown.version', "Debugging with legacy protocol because Node version could not be determined.");
	const defaultResult = { reason: unknownProtocolMessage, protocol: 'legacy' };

	const socket = new net.Socket();
	const cleanup = () => {
		socket.write(`"Content-Length: 50\r\n\r\n{"command":"disconnect","type":"request","seq":2}"`);
		socket.end();
	};

	return new Promise<{reason: string, protocol: string}>(resolve => {
		socket.once('data', data => {
			let reason: string;
			let protocol: string;
			const dataStr = data.toString();
			if (dataStr.indexOf('WebSockets request was expected') >= 0) {
				reason = localize('protocol.switch.inspector.version', "Debugging with inspector protocol because it was detected");
				protocol = 'inspector';
			} else {
				reason = localize('protocol.switch.legacy.version', "Debugging with legacy protocol because it was detected");
				protocol = 'legacy';
			}

			resolve({ reason, protocol });
		});

		socket.once('error', err => {
			resolve(defaultResult);
		});

		socket.connect(port, address);
		socket.write(`Content-Length: 102\r\n\r\n{"command":"evaluate","arguments":{"expression":"process.pid","global":true},"type":"request","seq":1}`);

		setTimeout(() => {
			// No data or error received? Bail and let the debug adapter handle it.
			resolve(defaultResult);
		}, 1000);
	}).catch(err => {
		return defaultResult;
	}).then(result => {
		cleanup();
		log(result.reason);

		return result.protocol;
	});
}

/**
 * convert the 3 parts of a semVer string into a single number
 */
function semVerStringToInt(vString: string): number {
	const match = vString.match(/v(\d+)\.(\d+)\.(\d+)/);
	if (match && match.length === 4) {
		return (parseInt(match[1])*100 + parseInt(match[2]))*100 + parseInt(match[3]);
	}
	return -1;
}
