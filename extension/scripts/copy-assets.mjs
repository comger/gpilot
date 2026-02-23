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

// 复制并处理 CSS 文件
const possibleContentCss = [resolve(distDir, 'style.css'), resolve(distDir, 'index2.css'), resolve(distDir, 'index.css')];
const possiblePopupCss = [resolve(distDir, 'popup.css'), resolve(distDir, 'index.css'), resolve(distDir, 'style.css')];

let contentFound = false;
for (const src of possibleContentCss) {
    if (existsSync(src) && !contentFound) {
        copyFileSync(src, resolve(distDir, 'content.css'));
        contentFound = true;
        console.log(`✅ Found and copied content.css from ${src}`);
    }
}

let popupFound = false;
// 注意：如果 popup.css 已经存在（由 vite 配置直接生成），则优先使用
if (existsSync(resolve(distDir, 'popup.css'))) {
    popupFound = true;
} else {
    for (const src of possiblePopupCss) {
        if (existsSync(src) && !popupFound && src !== resolve(distDir, 'content.css')) {
            copyFileSync(src, resolve(distDir, 'popup.css'));
            popupFound = true;
            console.log(`✅ Found and copied popup.css from ${src}`);
        }
    }
}

// 移动并修正 popup.html 到根目录，扁平化结构更稳健
const oldPopupHtmlPath = resolve(distDir, 'src/popup/index.html');
const newPopupHtmlPath = resolve(distDir, 'popup.html');

if (existsSync(oldPopupHtmlPath)) {
    let html = readFileSync(oldPopupHtmlPath, 'utf-8');
    // 扁平化后，路径变为相对于根
    html = html.replace(/src=\"[^\"]+assets\//g, 'src="./assets/');
    html = html.replace(/href=\"[^\"]+\.css\"/g, 'href="./popup.css"');

    writeFileSync(newPopupHtmlPath, html);
    console.log('✅ Popup HTML moved to root (dist/popup.html) and paths flattened');
}

// 修正 manifest.json 中的 popup 路径
manifest.action.default_popup = 'popup.html';
writeFileSync(resolve(distDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('✅ manifest.json updated with flattened popup path');

// 如果 icons 存在则复制
const iconsDir = resolve(root, 'public/icons');
if (existsSync(iconsDir)) {
    mkdirSync(resolve(distDir, 'icons'), { recursive: true });
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
