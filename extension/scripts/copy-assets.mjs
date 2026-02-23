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
const contentCss = resolve(distDir, 'index2.css');
const popupCss = resolve(distDir, 'index.css');

if (existsSync(contentCss)) {
    copyFileSync(contentCss, resolve(distDir, 'content.css'));
} else {
    // 兜底：如果 Vite 输出了不同的名字，尝试寻找最大的那个或者特定的
    console.log('ℹ️ index2.css not found, trying other CSS names...');
}

if (existsSync(popupCss)) {
    copyFileSync(popupCss, resolve(distDir, 'popup.css'));
}

// 清理不需要的 index.css (如果已重命名)
if (existsSync(resolve(distDir, 'index.css'))) {
    // unlinkSync(resolve(distDir, 'index.css')); // 暂时保留以防万一
}

// 修正 popup/index.html 中的 CSS 引用
const popupHtmlPath = resolve(distDir, 'src/popup/index.html');
if (existsSync(popupHtmlPath)) {
    let html = readFileSync(popupHtmlPath, 'utf-8');
    html = html.replace(/index\.css/g, '../../popup.css');
    writeFileSync(popupHtmlPath, html);
    console.log('✅ Updated popup/index.html CSS path');
}

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
