/** 本文件负责用户端运行时 SEO 元信息，公开页面切换时同步标题、描述和规范链接。 */
import { useEffect } from 'react';

const SITE_NAME = '绘图姬 DrawHime';
const BASE_URL = 'https://www.xanime.ink';
const DEFAULT_DESCRIPTION = '绘图姬 DrawHime 提供在线 AI 绘图、图生图、参考图创作、个人图库和 Bot 绘图能力。';
const DEFAULT_IMAGE = `${BASE_URL}/og-image.png`;

type SeoProps = {
  /** 页面标题，组件会自动追加站点名。 */
  title?: string;
  /** 页面摘要，用于搜索结果和社交分享卡片。 */
  description?: string;
  /** 规范路径，只传站内路径，避免 query 参数造成重复索引。 */
  path?: string;
  /** 是否允许搜索引擎索引当前页面。 */
  index?: boolean;
  /** 分享图地址，默认使用站点通用大图。 */
  image?: string;
};

/** 用户端 SEO 组件：集中维护 title、meta、canonical 和社交分享字段。 */
export function Seo({
  title,
  description = DEFAULT_DESCRIPTION,
  path = '/',
  index = true,
  image = DEFAULT_IMAGE,
}: SeoProps) {
  useEffect(() => {
    const pageTitle = title ? `${title} - ${SITE_NAME}` : '绘图姬 DrawHime - AI绘图与图生图创作平台';
    const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
    document.title = pageTitle;
    setMeta('name', 'description', description);
    setMeta('name', 'robots', index ? 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1' : 'noindex,nofollow');
    setMeta('name', 'googlebot', index ? 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1' : 'noindex,nofollow');
    setMeta('name', 'bingbot', index ? 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1' : 'noindex,nofollow');
    setMeta('property', 'og:title', pageTitle);
    setMeta('property', 'og:description', description);
    setMeta('property', 'og:url', url);
    setMeta('property', 'og:image', image);
    setMeta('property', 'og:image:type', image.endsWith('.png') ? 'image/png' : 'image/svg+xml');
    setMeta('name', 'twitter:title', pageTitle);
    setMeta('name', 'twitter:description', description);
    setMeta('name', 'twitter:image', image);
    setCanonical(url);
  }, [description, image, index, path, title]);

  return null;
}

/** 设置或创建 meta 标签，避免页面组件重复堆叠。 */
function setMeta(kind: 'name' | 'property', key: string, value: string): void {
  const selector = `meta[${kind}="${key}"]`;
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(kind, key);
    document.head.appendChild(element);
  }
  element.content = value;
}

/** 设置或创建 canonical 链接。 */
function setCanonical(href: string): void {
  let element = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!element) {
    element = document.createElement('link');
    element.rel = 'canonical';
    document.head.appendChild(element);
  }
  element.href = href;
}
