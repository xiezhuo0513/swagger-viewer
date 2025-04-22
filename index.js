// cursor-swagger-plugin: MCP 插件起始模板（支持项目自定义配置 + 接口搜索 + 插入代码）

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

// 获取用户根目录下的 swagger.json 文件路径
function getSwaggerConfigPath() {
    const homeDir = os.homedir();
    return path.join(homeDir, 'swagger.json');
}

// 读取并解析 swagger.json 文件
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

// 获取并解析 Swagger 文档
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

// 搜索接口
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

// 生成接口调用代码
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

// 监听 swagger.json 文件变化
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

// 初始化函数
async function initialize() {
    const config = await readSwaggerConfig();
    if (config && config.swaggerUrl) {
        swaggerCache = await fetchSwaggerDoc(config.swaggerUrl);
        watchSwaggerConfig();
    }
}

// MCP 工具接口
export async function mcp_swagger_initialize() {
    await initialize();
    return { success: true };
}

export async function mcp_swagger_search(query) {
    if (!swaggerCache) {
        await initialize();
    }
    return searchEndpoints(swaggerCache, query);
}

export async function mcp_swagger_generate_code(path, method, language = 'javascript') {
    if (!swaggerCache) {
        await initialize();
    }
    
    const endpoint = swaggerCache.paths[path][method.toLowerCase()];
    if (!endpoint) {
        return { error: 'Endpoint not found' };
    }
    
    return {
        code: generateCode({ path, method, ...endpoint }, language)
    };
}

export async function mcp_swagger_get_all_endpoints() {
    if (!swaggerCache) {
        await initialize();
    }
    
    return Object.entries(swaggerCache.paths).map(([path, methods]) => ({
        path,
        methods: Object.keys(methods)
    }));
}

// 初始化
initialize();
