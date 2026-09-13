const fs = require('fs');
let html = fs.readFileSync('E:/Posao/Veltron Site V2/journal.html', 'utf-8');

// Replace meta tags
html = html.replace(/<title>.*?<\/title>/, '<!-- INJECT_META -->');
html = html.replace(/<meta name="description".*?>/, '');
html = html.replace(/<meta property="og:title".*?>/, '');
html = html.replace(/<meta property="og:description".*?>/, '');
html = html.replace(/<meta name="twitter:title".*?>/, '');
html = html.replace(/<meta name="twitter:description".*?>/, '');

// Fix asset and navigation links to point to the main domain
html = html.replace(/href="Assets\//g, 'href="https://veltroncars.com/Assets/');
html = html.replace(/src="Assets\//g, 'src="https://veltroncars.com/Assets/');
html = html.replace(/href="([a-zA-Z0-9-]+\.html)(#.*?)?"/g, 'href="https://veltroncars.com/$1$2"');

// Fix the 'Journal' nav link to point to root of this subdomain
html = html.replace(/href="https:\/\/veltroncars\.com\/journal\.html"/g, 'href="/"');

// Inject points
html = html.replace(/<div class="journal-grid" id="journal-grid">[\s\S]*?<\/div>/, '<div class="journal-grid" id="journal-grid" style="<!-- INJECT_GRID_STYLE -->"><!-- INJECT_CARDS --></div>');
html = html.replace(/<article class="article-reader" id="article-reader">[\s\S]*?<\/article>/, '<!-- INJECT_ARTICLE_READER -->');

// Remove the client-side fetch script
html = html.replace(/<script>[\s\S]*const API_BASE[\s\S]*?<\/script>/, '<!-- JS handled server side -->');
html = html.replace(/<script src="https:\/\/veltroncars\.com\/script\.js"><\/script>/, '');

// Also hide filters and hero if it's an article
html = html.replace(/id="journal-filters"/, 'id="journal-filters" style="<!-- INJECT_FILTERS_STYLE -->"');
html = html.replace(/id="journal-hero"/, 'id="journal-hero" style="<!-- INJECT_HERO_STYLE -->"');

fs.mkdirSync('E:/Posao/veltron-backend/views', { recursive: true });
fs.writeFileSync('E:/Posao/veltron-backend/views/journal.html', html);
console.log('Template created!');
