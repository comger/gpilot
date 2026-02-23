// 构建后处理脚本：将 manifest.json 和 icon 等静态资源复制到 dist/
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const distDir = resolve(root, 'dist');

// 确保 dist 目录存在
mkdirSync(distDir, { recursive: true });
mkdirSync(resolve(distDir, 'icons'), { recursive: true });

// 复制并修改 manifest.json（更新文件路径）
const manifestSrc = resolve(root, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestSrc, 'utf-8'));

// 修改 manifest 中的路径以匹配 Vite 输出结构
manifest.background.service_worker = 'background.js';
manifest.background.type = 'module';
manifest.content_scripts[0].js = ['content.js'];
manifest.content_scripts[0].css = ['content.css'];
manifest.action.default_popup = 'src/popup/index.html';
manifest.action.default_icon = {
    '16': 'icons/icon16.png',
    '48': 'icons/icon48.png',
    '128': 'icons/icon128.png',
};
manifest.icons = {
    '16': 'icons/icon16.png',
    '48': 'icons/icon48.png',
    '128': 'icons/icon128.png',
};
manifest.web_accessible_resources = [
    { resources: ['content.css', 'content.js'], matches: ['<all_urls>'] }
];

writeFileSync(resolve(distDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('✅ manifest.json copied to dist/');

// 复制 popup HTML (Vite 会输出但路径可能需调整)
// popup.html 由 Vite 自动生成到 dist/，不需要手动复制

// 如果 icons 存在则复制
const iconsDir = resolve(root, 'public/icons');
if (existsSync(iconsDir)) {
    ['icon16.png', 'icon48.png', 'icon128.png'].forEach(icon => {
        const src = resolve(iconsDir, icon);
        if (existsSync(src)) {
            copyFileSync(src, resolve(distDir, 'icons', icon));
            console.log(`✅ Copied ${icon}`);
        }
    });
} else {
    console.log('ℹ️  No icons found in public/icons, skip icon copy');
}

console.log('🎉 Post-build assets copied successfully!');
