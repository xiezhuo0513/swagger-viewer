#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from 'node-fetch';
import SwaggerParser from 'swagger-parser';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import chokidar from 'chokidar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 缓存 swagger 数据
let swaggerCache = null;
let swaggerWatcher = null;

// 定义工具
const SWAGGER_INITIALIZE: Tool = {
  name: "mcp_swagger_initialize",
  description: "初始化 Swagger 工具并加载配置",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

const SWAGGER_SEARCH: Tool = {
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

const SWAGGER_GENERATE_CODE: Tool = {
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

const SWAGGER_GET_ALL_ENDPOINTS: Tool = {
  name: "mcp_swagger_get_all_endpoints",
  description: "获取所有可用接口",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

// 工具函数
function getSwaggerConfigPath() {
    const homeDir = os.homedir();
    return path.join(homeDir, 'swagger.json');
}

async function readSwaggerConfig() {
    const configPath = getSwaggerConfigPath();
    try {
        const exists = await fs.pathExists(configPath);
        if (!exists) {
            return null;
        }
        const config = await fs.readJson(configPath);
        return config;
    } catch (error) {
        console.error('Error reading swagger config:', error);
        return null;
    }
}

async function fetchSwaggerDoc(url) {
    try {
        const response = await fetch(url);
        const data = await response.json();
        const api = await SwaggerParser.validate(data);
        return api;
    } catch (error) {
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
        const paramList = parameters ? parameters.map(p => p.name).join(', ') : '';
        const functionName = path.split('/').filter(Boolean).join('_');
        
        return `async function ${functionName}(${paramList}) {
    const response = await fetch('${path}', {
        method: '${method}',
        headers: {
            'Content-Type': 'application/json',
        },
        ${parameters ? `body: JSON.stringify({ ${paramList} }),` : ''}
    });
    return response.json();
}`;
    }
    
    return '// Code generation for other languages not implemented yet';
}

function watchSwaggerConfig() {
    if (swaggerWatcher) {
        swaggerWatcher.close();
    }

    const configPath = getSwaggerConfigPath();
    swaggerWatcher = chokidar.watch(configPath, {
        persistent: true
    });

    swaggerWatcher.on('change', async () => {
        console.log('Swagger config changed, updating...');
        const config = await readSwaggerConfig();
        if (config && config.swaggerUrl) {
            swaggerCache = await fetchSwaggerDoc(config.swaggerUrl);
        }
    });
}

// 初始化服务器
const server = new Server(
  {
    name: "swagger-viewer",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// 注册工具处理器
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [SWAGGER_INITIALIZE, SWAGGER_SEARCH, SWAGGER_GENERATE_CODE, SWAGGER_GET_ALL_ENDPOINTS],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "mcp_swagger_initialize": {
        const config = await readSwaggerConfig();
        if (config && config.swaggerUrl) {
            swaggerCache = await fetchSwaggerDoc(config.swaggerUrl);
            watchSwaggerConfig();
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true }) }],
          isError: false,
        };
      }

      case "mcp_swagger_search": {
        if (!swaggerCache) {
          await server.handleRequest(CallToolRequestSchema, {
            params: { name: "mcp_swagger_initialize", arguments: {} }
          });
        }
        const results = searchEndpoints(swaggerCache, args.query);
        return {
          content: [{ type: "text", text: JSON.stringify(results) }],
          isError: false,
        };
      }

      case "mcp_swagger_generate_code": {
        if (!swaggerCache) {
          await server.handleRequest(CallToolRequestSchema, {
            params: { name: "mcp_swagger_initialize", arguments: {} }
          });
        }
        const endpoint = swaggerCache.paths[args.path][args.method.toLowerCase()];
        if (!endpoint) {
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
          await server.handleRequest(CallToolRequestSchema, {
            params: { name: "mcp_swagger_initialize", arguments: {} }
          });
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
  } catch (error) {
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
