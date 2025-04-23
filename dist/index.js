#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import fetch from 'node-fetch';
import SwaggerParser from '@apidevtools/swagger-parser';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 添加工作空间路径常量
const WORKSPACE_PATH = decodeURIComponent('/d%3A/Code_xie/swagger-viewer');
// 缓存 swagger 数据
let swaggerCache = null;
let swaggerWatcher = null;
// 定义工具
const SWAGGER_INITIALIZE = {
    name: "mcp_swagger_initialize",
    description: "初始化 Swagger 工具并加载配置",
    inputSchema: {
        type: "object",
        properties: {
            swaggerUrl: {
                type: "string",
                description: "Swagger 文档的 URL"
            }
        },
        required: ["swaggerUrl"],
    },
};
const SWAGGER_SEARCH = {
    name: "mcp_swagger_search",
    description: "搜索 API 接口",
    inputSchema: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "搜索关键词"
            }
        },
        required: ["query"],
    },
};
const SWAGGER_GENERATE_CODE = {
    name: "mcp_swagger_generate_code",
    description: "生成接口调用代码",
    inputSchema: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "API 路径"
            },
            method: {
                type: "string",
                description: "HTTP 方法"
            },
            language: {
                type: "string",
                description: "编程语言",
                default: "javascript"
            }
        },
        required: ["path", "method"],
    },
};
const SWAGGER_GET_ALL_ENDPOINTS = {
    name: "mcp_swagger_get_all_endpoints",
    description: "获取所有可用接口",
    inputSchema: {
        type: "object",
        properties: {},
        required: [],
    },
};
async function fetchSwaggerDoc(url) {
    try {
        const response = await fetch(url);
        const data = await response.json();
        const api = await SwaggerParser.bundle(data);
        return api;
    }
    catch (error) {
        console.error('Error fetching swagger doc:', error);
        return null;
    }
}
function searchEndpoints(swagger, query) {
    if (!swagger || !swagger.paths) {
        return [];
    }
    const results = [];
    const paths = Object.keys(swagger.paths);
    for (const path of paths) {
        const methods = swagger.paths[path];
        for (const method of Object.keys(methods)) {
            const endpoint = methods[method];
            const searchText = [
                path,
                method,
                endpoint.summary,
                endpoint.description,
                endpoint.operationId
            ].filter(Boolean).join(' ').toLowerCase();
            if (searchText.includes(query.toLowerCase())) {
                results.push({
                    path,
                    method: method.toUpperCase(),
                    summary: endpoint.summary,
                    description: endpoint.description,
                    parameters: endpoint.parameters,
                    responses: endpoint.responses
                });
            }
        }
    }
    return results;
}
function generateCode(endpoint, language = 'javascript') {
    const { path, method, parameters } = endpoint;
    if (language === 'javascript') {
        // 处理参数
        const queryParams = parameters?.filter(p => p.in === 'query') || [];
        const bodyParams = parameters?.filter(p => p.in === 'body') || [];
        const pathParams = parameters?.filter(p => p.in === 'path') || [];
        // 构建函数参数列表
        const allParams = [...queryParams, ...bodyParams, ...pathParams];
        const paramList = allParams.map(p => p.name).join(', ');
        // 构建函数名
        const functionName = path
            .split('/')
            .filter(Boolean)
            .map(s => s.replace(/[^a-zA-Z0-9]/g, '_'))
            .join('_');
        // 处理路径参数
        let urlPath = path;
        pathParams.forEach(p => {
            urlPath = urlPath.replace(`{${p.name}}`, `\${${p.name}}`);
        });
        // 处理查询参数
        let queryString = '';
        if (queryParams.length > 0) {
            queryString = `const queryString = new URLSearchParams(
                ${JSON.stringify(queryParams.map(p => p.name))}
                .filter(key => typeof eval(key) !== 'undefined')
                .reduce((obj, key) => ({ ...obj, [key]: eval(key) }), {})
            ).toString();`;
        }
        // 生成代码
        return `async function ${functionName}(${paramList}) {
    ${queryString}
    const url = \`${urlPath}\${queryString ? '?' + queryString : ''}\`;
    
    const options = {
        method: '${method}',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }${bodyParams.length > 0 ? `,
        body: JSON.stringify(${bodyParams[0].name})` : ''}
    };

    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            throw new Error(\`HTTP error! status: \${response.status}\`);
        }
        return await response.json();
    } catch (error) {
        console.error('API call failed:', error);
        throw error;
    }
}`;
    }
    // 如果需要支持其他语言，可以在这里添加
    return `// ${language} code generation is not supported yet`;
}
// 初始化服务器
const server = new Server({
    name: "swagger-viewer",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {},
    },
});
// 注册工具处理器
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [SWAGGER_INITIALIZE, SWAGGER_SEARCH, SWAGGER_GENERATE_CODE, SWAGGER_GET_ALL_ENDPOINTS],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
        const { name, arguments: args } = request.params;
        switch (name) {
            case "mcp_swagger_initialize": {
                if (!args.swaggerUrl) {
                    return {
                        content: [{ type: "text", text: JSON.stringify({
                                    success: false,
                                    error: "swaggerUrl is required"
                                }) }],
                        isError: true
                    };
                }
                try {
                    swaggerCache = await fetchSwaggerDoc(args.swaggerUrl);
                    if (!swaggerCache) {
                        return {
                            content: [{ type: "text", text: JSON.stringify({
                                        success: false,
                                        error: "Failed to fetch swagger documentation"
                                    }) }],
                            isError: true
                        };
                    }
                    return {
                        content: [{ type: "text", text: JSON.stringify({
                                    success: true,
                                    cacheStatus: 'loaded'
                                }) }],
                        isError: false
                    };
                }
                catch (error) {
                    return {
                        content: [{ type: "text", text: JSON.stringify({
                                    success: false,
                                    error: error instanceof Error ? error.message : String(error)
                                }) }],
                        isError: true
                    };
                }
            }
            case "mcp_swagger_search": {
                if (!swaggerCache) {
                    return {
                        content: [{ type: "text", text: JSON.stringify({
                                    error: "Please initialize swagger first"
                                }) }],
                        isError: true
                    };
                }
                if (!args.query) {
                    return {
                        content: [{ type: "text", text: JSON.stringify({ error: "Query is required" }) }],
                        isError: true,
                    };
                }
                const results = searchEndpoints(swaggerCache, args.query);
                return {
                    content: [{ type: "text", text: JSON.stringify(results) }],
                    isError: false,
                };
            }
            case "mcp_swagger_generate_code": {
                if (!swaggerCache) {
                    return {
                        content: [{ type: "text", text: JSON.stringify({
                                    error: "Please initialize swagger first"
                                }) }],
                        isError: true
                    };
                }
                if (!args.path || !args.method) {
                    return {
                        content: [{ type: "text", text: JSON.stringify({ error: "Path and method are required" }) }],
                        isError: true,
                    };
                }
                const methodLower = args.method.toLowerCase();
                const endpoint = swaggerCache?.paths[args.path]?.[methodLower];
                if (!endpoint) {
                    return {
                        content: [{ type: "text", text: JSON.stringify({ error: 'Endpoint not found' }) }],
                        isError: true,
                    };
                    return {
                        content: [{ type: "text", text: JSON.stringify({ error: 'Endpoint not found' }) }],
                        isError: true,
                    };
                }
                const code = generateCode({ path: args.path, method: args.method, ...endpoint }, args.language);
                return {
                    content: [{ type: "text", text: JSON.stringify({ code }) }],
                    isError: false,
                };
            }
            case "mcp_swagger_get_all_endpoints": {
                if (!swaggerCache) {
                    return {
                        content: [{ type: "text", text: JSON.stringify({
                                    error: "Please initialize swagger first"
                                }) }],
                        isError: true
                    };
                }
                if (!swaggerCache?.paths) {
                    return {
                        content: [{ type: "text", text: JSON.stringify({ error: "No endpoints available" }) }],
                        isError: true,
                    };
                }
                const endpoints = Object.entries(swaggerCache.paths).map(([path, methods]) => ({
                    path,
                    methods: Object.keys(methods)
                }));
                return {
                    content: [{ type: "text", text: JSON.stringify(endpoints) }],
                    isError: false,
                };
            }
            default:
                return {
                    content: [{ type: "text", text: `Unknown tool: ${name}` }],
                    isError: true,
                };
        }
    }
    catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
});
// 启动服务器
async function runServer() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Swagger Viewer MCP Server running on stdio");
}
runServer().catch((error) => {
    console.error("Fatal error running server:", error);
    process.exit(1);
});
