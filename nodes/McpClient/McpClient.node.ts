import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeConnectionType,
	NodeOperationError,
} from 'n8n-workflow';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

// Add Node.js process type declaration
declare const process: {
	env: Record<string, string | undefined>;
};

export class McpClient implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'MCP Client',
		name: 'mcpClient',
		icon: 'file:mcpClient.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Use MCP client',
		defaults: {
			name: 'MCP Client',
		},
		// @ts-ignore - node-class-description-outputs-wrong
		inputs: [{ type: NodeConnectionType.Main }],
		// @ts-ignore - node-class-description-outputs-wrong
		outputs: [{ type: NodeConnectionType.Main }],
		usableAsTool: true,
		credentials: [
			{
				name: 'mcpClientApi',
				required: false,
				displayOptions: {
					show: {
						connectionType: ['cmd'],
					},
				},
			},
			{
				name: 'mcpClientSseApi',
				required: false,
				displayOptions: {
					show: {
						connectionType: ['sse'],
					},
				},
			},
			{
				name: 'mcpClientHttpApi',
				required: false,
				displayOptions: {
					show: {
						connectionType: ['http'],
					},
				},
			},
		],
		properties: [
			{
				displayName: 'Connection Type',
				name: 'connectionType',
				type: 'options',
				options: [
					{
						name: 'Command Line (STDIO)',
						value: 'cmd',
					},
					{
						name: 'Server-Sent Events (SSE)',
						value: 'sse',
						description: 'Deprecated: Use HTTP Streamable instead',
					},
					{
						name: 'HTTP Streamable',
						value: 'http',
						description: 'Use HTTP streamable protocol for real-time communication',
					},
				],
				default: 'cmd',
				description: 'Choose the transport type to connect to MCP server',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Execute Tool',
						value: 'executeTool',
						description: 'Execute a specific tool',
						action: 'Execute a tool',
					},
					{
						name: 'Get Prompt',
						value: 'getPrompt',
						description: 'Get a specific prompt template',
						action: 'Get a prompt template',
					},
					{
						name: 'List Prompts',
						value: 'listPrompts',
						description: 'Get available prompts',
						action: 'List available prompts',
					},
					{
						name: 'List Resource Templates',
						value: 'listResourceTemplates',
						description: 'Get a list of available resource templates',
						action: 'List available resource templates',
					},
					{
						name: 'List Resources',
						value: 'listResources',
						description: 'Get a list of available resources',
						action: 'List available resources',
					},
					{
						name: 'List Tools',
						value: 'listTools',
						description: 'Get available tools',
						action: 'List available tools',
					},
					{
						name: 'Read Resource',
						value: 'readResource',
						description: 'Read a specific resource by URI',
						action: 'Read a resource',
					},
				],
				default: 'listTools',
				required: true,
			},
			{
				displayName: 'Resource URI',
				name: 'resourceUri',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						operation: ['readResource'],
					},
				},
				default: '',
				description: 'URI of the resource to read',
			},
			{
				displayName: 'Tool Name',
				name: 'toolName',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						operation: ['executeTool'],
					},
				},
				default: '',
				description: 'Name of the tool to execute',
			},
			{
				displayName: 'Tool Parameters',
				name: 'toolParameters',
				type: 'json',
				required: true,
				displayOptions: {
					show: {
						operation: ['executeTool'],
					},
				},
				default: '{}',
				description: 'Parameters to pass to the tool in JSON format',
			},
			{
				displayName: 'Prompt Name',
				name: 'promptName',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						operation: ['getPrompt'],
					},
				},
				default: '',
				description: 'Name of the prompt template to get',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const returnData: INodeExecutionData[] = [];
		const operation = this.getNodeParameter('operation', 0) as string;
		let transport: Transport | undefined;

		// For backward compatibility - if connectionType isn't set, default to 'cmd'
		let connectionType = 'cmd';
		try {
			connectionType = this.getNodeParameter('connectionType', 0) as string;
		} catch (error) {
			// If connectionType parameter doesn't exist, keep default 'cmd'
			this.logger.debug('ConnectionType parameter not found, using default "cmd" transport');
		}
		let timeout = 600000;

		try {
			if (connectionType === 'http') {
				// Use HTTP Streamable transport
				const httpCredentials = await this.getCredentials('mcpClientHttpApi');

				// Dynamically import the HTTP client
				const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

				const httpStreamUrl = httpCredentials.httpStreamUrl as string;
				const messagesPostEndpoint = (httpCredentials.messagesPostEndpoint as string) || '';
				timeout = httpCredentials.httpTimeout as number || 60000;

				// Parse headers
				let headers: Record<string, string> = {};
				if (httpCredentials.headers) {
					const headersPairs = (httpCredentials.headers as string).split(/[\n,]+/);
					for (const pair of headersPairs) {
						const trimmedPair = pair.trim();
						if (trimmedPair) {
							const equalsIndex = trimmedPair.indexOf('=');
							if (equalsIndex > 0) {
								const name = trimmedPair.substring(0, equalsIndex).trim();
								const value = trimmedPair.substring(equalsIndex + 1).trim();
								if (name && value !== undefined) {
									headers[name] = value;
								}
							}
						}
					}
				}

				const requestInit: RequestInit = { headers };
				if (messagesPostEndpoint) {
					(requestInit as any).endpoint = new URL(messagesPostEndpoint);
				}

				transport = new StreamableHTTPClientTransport(
					new URL(httpStreamUrl),
					{ requestInit }
				);
			} else if (connectionType === 'sse') {
				// Use SSE transport
				const sseCredentials = await this.getCredentials('mcpClientSseApi');

				// Dynamically import the SSE client to avoid TypeScript errors
				const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');

				const sseUrl = sseCredentials.sseUrl as string;
				const messagesPostEndpoint = (sseCredentials.messagesPostEndpoint as string) || '';
				timeout = sseCredentials.sseTimeout as number || 60000;

				// Parse headers
				let headers: Record<string, string> = {};
				if (sseCredentials.headers) {
					const headersPairs = (sseCredentials.headers as string).split(/[\n,]+/);
					for (const pair of headersPairs) {
						const trimmedPair = pair.trim();
						if (trimmedPair) {
							const equalsIndex = trimmedPair.indexOf('=');
							if (equalsIndex > 0) {
								const name = trimmedPair.substring(0, equalsIndex).trim();
								const value = trimmedPair.substring(equalsIndex + 1).trim();
								if (name && value !== undefined) {
									headers[name] = value;
								}
							}
						}
					}
				}

				// Create SSE transport with dynamic import to avoid TypeScript errors
				transport = new SSEClientTransport(
					// @ts-ignore
					new URL(sseUrl),
					{
						// @ts-ignore
						eventSourceInit: { headers },
						// @ts-ignore
						requestInit: {
							headers,
							...(messagesPostEndpoint
								? {
									// @ts-ignore
									endpoint: new URL(messagesPostEndpoint),
								}
								: {}),
						},
					},
				);

				this.logger.debug(`Created SSE transport for MCP client URL: ${sseUrl}`);
				if (messagesPostEndpoint) {
					this.logger.debug(`Using custom POST endpoint: ${messagesPostEndpoint}`);
				}
			} else {
				// Use stdio transport (default)
				const cmdCredentials = await this.getCredentials('mcpClientApi');

				// Build environment variables object for MCP servers
				const env: Record<string, string> = {
					// Preserve the PATH environment variable to ensure commands can be found
					PATH: process.env.PATH || '',
				};

				this.logger.debug(`Original PATH: ${process.env.PATH}`);

				// Parse comma-separated environment variables from credentials
				if (cmdCredentials.environments) {
					const envPairs = (cmdCredentials.environments as string).split(/[,\n\s]+/);
					for (const pair of envPairs) {
						const trimmedPair = pair.trim();
						if (trimmedPair) {
							const equalsIndex = trimmedPair.indexOf('=');
							if (equalsIndex > 0) {
								const name = trimmedPair.substring(0, equalsIndex).trim();
								const value = trimmedPair.substring(equalsIndex + 1).trim();
								if (name && value !== undefined) {
									env[name] = value;
								}
							}
						}
					}
				}

				// Process environment variables from Node.js
				// This allows Docker environment variables to override credentials
				for (const key in process.env) {
					// Only pass through MCP-related environment variables
					if (key.startsWith('MCP_') && process.env[key]) {
						// Strip off the MCP_ prefix when passing to the MCP server
						const envName = key.substring(4); // Remove 'MCP_'
						env[envName] = process.env[key] as string;
					}
				}

				transport = new StdioClientTransport({
					command: cmdCredentials.command as string,
					args: (cmdCredentials.args as string)?.split(' ') || [],
					env: env, // Always pass the env with PATH preserved
				});

				// Use n8n's logger instead of console.log
				this.logger.debug(
					`Transport created for MCP client command: ${cmdCredentials.command}, PATH: ${env.PATH}`,
				);
			}

			// Add error handling to transport
			if (transport) {
				transport.onerror = (error: Error) => {
					throw new NodeOperationError(this.getNode(), `Transport error: ${error.message}`);
				};
			}

			const client = new Client(
				{
					name: `${McpClient.name}-client`,
					version: '1.0.0',
				},
				{
					capabilities: {
						prompts: {},
						resources: {},
						tools: {},
					},
				},
			);

			try {
				if (!transport) {
					throw new NodeOperationError(this.getNode(), 'No transport available');
				}
				await client.connect(transport);
				this.logger.debug('Client connected to MCP server');
			} catch (connectionError) {
				this.logger.error(`MCP client connection error: ${(connectionError as Error).message}`);
				throw new NodeOperationError(
					this.getNode(),
					`Failed to connect to MCP server: ${(connectionError as Error).message}`,
				);
			}

			// Create a RequestOptions object from environment variables
			const requestOptions: RequestOptions = {};
			requestOptions.timeout = timeout;

			switch (operation) {
				case 'listResources': {
					const resources = await client.listResources();
					returnData.push({
						json: { resources },
					});
					break;
				}

				case 'listResourceTemplates': {
					const resourceTemplates = await client.listResourceTemplates();
					returnData.push({
						json: { resourceTemplates },
					});
					break;
				}

				case 'readResource': {
					const uri = this.getNodeParameter('resourceUri', 0) as string;
					const resource = await client.readResource({
						uri,
					});
					returnData.push({
						json: { resource },
					});
					break;
				}

				case 'listTools': {
					const rawTools = await client.listTools();

					// Ensure we have a proper object, not a string
					let parsedTools;
					if (typeof rawTools === 'string') {
						try {
							parsedTools = JSON.parse(rawTools);
						} catch (error) {
							throw new NodeOperationError(
								this.getNode(),
								`Failed to parse tools response: ${(error as Error).message}`,
							);
						}
					} else {
						parsedTools = rawTools;
					}

					// Extract tools array from the response
					const tools = Array.isArray(parsedTools)
						? parsedTools
						: Array.isArray(parsedTools?.tools)
							? parsedTools.tools
							: Array.isArray(parsedTools?.result?.tools)
								? parsedTools.result.tools
								: Object.values(parsedTools?.tools || {});

					if (!tools.length) {
						throw new NodeOperationError(this.getNode(), 'No tools found from MCP client');
					}

					// Log the tools for debugging
					this.logger.debug(`Received tools: ${JSON.stringify(tools, null, 2)}`);

					// Create tools for execution
					tools.forEach((tool: any) => {
						const paramSchema = tool.inputSchema?.properties
							? z.object(
								Object.entries(tool.inputSchema.properties).reduce(
									(acc: any, [key, prop]: [string, any]) => {
										let zodType: z.ZodType;

										switch (prop.type) {
											case 'string':
												zodType = z.string();
												break;
											case 'number':
												zodType = z.number();
												break;
											case 'integer':
												zodType = z.number().int();
												break;
											case 'boolean':
												zodType = z.boolean();
												break;
											case 'array':
												if (prop.items?.type === 'string') {
													zodType = z.array(z.string());
												} else if (prop.items?.type === 'number') {
													zodType = z.array(z.number());
												} else if (prop.items?.type === 'boolean') {
													zodType = z.array(z.boolean());
												} else {
													zodType = z.array(z.any());
												}
												break;
											case 'object':
												zodType = z.record(z.string(), z.any());
												break;
											default:
												zodType = z.any();
										}

										if (prop.description) {
											zodType = zodType.describe(prop.description);
										}

										if (!tool.inputSchema?.required?.includes(key)) {
											zodType = zodType.optional();
										}

										return {
											...acc,
											[key]: zodType,
										};
									},
									{},
								),
							)
							: z.object({});

						new DynamicStructuredTool({
							name: tool.name,
							description: tool.description || `Execute the ${tool.name} tool`,
							schema: paramSchema,
							func: async (params) => {
								try {
									const result = await client.callTool({
										name: tool.name,
										arguments: params,
									}, CallToolResultSchema, requestOptions);

									return result;
								} catch (error) {
									throw new NodeOperationError(
										this.getNode(),
										`Failed to execute ${tool.name}: ${(error as Error).message}`,
									);
								}
							},
						});
					});

					// Ensure we're returning the original schema from the MCP server
					const toolsResponse = tools.map((tool: any) => {
						// Log each tool's schema for debugging
						this.logger.debug(`Tool ${tool.name} schema: ${JSON.stringify(tool.inputSchema, null, 2)}`);

						return {
							name: tool.name,
							description: tool.description,
							schema: tool.inputSchema || {},
						};
					});

					returnData.push({
						json: {
							tools: toolsResponse,
						},
					});
					break;
				}

				case 'executeTool': {
					const toolName = this.getNodeParameter('toolName', 0) as string;
					let toolParams;

					try {
						const rawParams = this.getNodeParameter('toolParameters', 0);
						this.logger.debug(`Raw tool parameters: ${JSON.stringify(rawParams)}`);

						// Handle different parameter types
						if (rawParams === undefined || rawParams === null) {
							// Handle null/undefined case
							toolParams = {};
						} else if (typeof rawParams === 'string') {
							// Handle string input (typical direct node usage)
							if (!rawParams || rawParams.trim() === '') {
								toolParams = {};
							} else {
								toolParams = JSON.parse(rawParams);
							}
						} else if (typeof rawParams === 'object') {
							// Handle object input (when used as a tool in AI Agent)
							toolParams = rawParams;
						} else {
							// Try to convert other types to object
							try {
								toolParams = JSON.parse(JSON.stringify(rawParams));
							} catch (parseError) {
								throw new NodeOperationError(
									this.getNode(),
									`Invalid parameter type: ${typeof rawParams}`,
								);
							}
						}

						// Ensure toolParams is an object
						if (
							typeof toolParams !== 'object' ||
							toolParams === null ||
							Array.isArray(toolParams)
						) {
							throw new NodeOperationError(this.getNode(), 'Tool parameters must be a JSON object');
						}
					} catch (error) {
						throw new NodeOperationError(
							this.getNode(),
							`Failed to parse tool parameters: ${(error as Error).message
							}. Make sure the parameters are valid JSON.`,
						);
					}

					// Validate tool exists before executing
					try {
						const availableTools = await client.listTools();
						const toolsList = Array.isArray(availableTools)
							? availableTools
							: Array.isArray(availableTools?.tools)
								? availableTools.tools
								: Object.values(availableTools?.tools || {});

						const toolExists = toolsList.some((tool: any) => tool.name === toolName);

						if (!toolExists) {
							const availableToolNames = toolsList.map((t: any) => t.name).join(', ');
							throw new NodeOperationError(
								this.getNode(),
								`Tool '${toolName}' does not exist. Available tools: ${availableToolNames}`,
							);
						}

						this.logger.debug(
							`Executing tool: ${toolName} with params: ${JSON.stringify(toolParams)}`,
						);

						const result = await client.callTool({
							name: toolName,
							arguments: toolParams,
						}, CallToolResultSchema, requestOptions);

						this.logger.debug(`Tool executed successfully: ${JSON.stringify(result)}`);

						returnData.push({
							json: { result },
						});
					} catch (error) {
						throw new NodeOperationError(
							this.getNode(),
							`Failed to execute tool '${toolName}': ${(error as Error).message}`,
						);
					}
					break;
				}

				case 'listPrompts': {
					const prompts = await client.listPrompts();
					returnData.push({
						json: { prompts },
					});
					break;
				}

				case 'getPrompt': {
					const promptName = this.getNodeParameter('promptName', 0) as string;
					const prompt = await client.getPrompt({
						name: promptName,
					});
					returnData.push({
						json: { prompt },
					});
					break;
				}

				default:
					throw new NodeOperationError(this.getNode(), `Operation ${operation} not supported`);
			}

			return [returnData];
		} catch (error) {
			throw new NodeOperationError(
				this.getNode(),
				`Failed to execute operation: ${(error as Error).message}`,
			);
		} finally {
			if (transport) {
				await transport.close();
			}
		}
	}
}
