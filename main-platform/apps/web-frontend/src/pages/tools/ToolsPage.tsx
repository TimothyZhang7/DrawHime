/** 本页面只展示工具入口，不承载具体工具操作，保证后续工具扩展时入口页稳定。 */
import { Link } from 'react-router-dom';
import { ArrowRight, Grid3X3, ImageDown, ImageUpscale, MessageSquareText, ScanSearch, Shuffle, Waves, Wrench } from 'lucide-react';
import { Seo } from '../../components/Seo';
import { toolEntries } from './tools-registry';
import { useToolsConfig } from './useToolsConfig';
import './ToolsPage.css';

/** 用户端工具入口页。 */
export function ToolsPage() {
  const { loading, getToolConfig } = useToolsConfig();

  return (
    <div className="tools-home">
      <Seo title="工具" description="绘图姬 DrawHime 工具中心，提供格式转换与压缩、Agent 工作台、图片反推、拆分、混淆、局部抖动和图片放大。" path="/tools" />
      <header className="tools-home-header">
        <div>
          <div className="tools-home-kicker"><Wrench size={15} />工具中心</div>
          <h1>工具</h1>
          <p>选择一个工具进入独立页面使用。这里仅展示入口，具体操作和状态不会混在列表页里。</p>
        </div>
        <div className="tools-home-summary" aria-label="工具数量">
          <strong>{toolEntries.length}</strong>
          <span>已接入工具</span>
        </div>
      </header>

      <section className="tools-entry-grid" aria-label="工具入口">
        {toolEntries.map((tool) => {
          const config = tool.configId ? getToolConfig(tool.configId) : undefined;
          const enabled = !tool.configId || config?.enabled !== false;
          // 每个工具使用稳定图标，新增入口时不依赖服务端返回展示资源。
          const Icon = tool.id === 'workbench' ? MessageSquareText : tool.id === 'image-converter' ? ImageDown : tool.id === 'image-scrambler' ? Shuffle : tool.id === 'image-wobble' ? Waves : tool.id === 'image-reverse' ? ScanSearch : tool.id === 'image-upscale' ? ImageUpscale : Grid3X3;
          const content = (
            <>
              <div className="tools-entry-icon"><Icon size={22} /></div>
              <div className="tools-entry-body">
                <div className="tools-entry-meta">{tool.category}</div>
                <h2>{tool.title}</h2>
                <p>{tool.description}</p>
                <div className="tools-entry-foot">
                  <span className={`tools-entry-state ${enabled ? 'is-on' : 'is-off'}`}>
                    {tool.configId && loading ? '读取配置中' : enabled ? '可使用' : '已停用'}
                  </span>
                  <span className="tools-entry-hint">进入工具</span>
                </div>
              </div>
              <ArrowRight size={18} className="tools-entry-arrow" />
            </>
          );
          return enabled ? (
            <Link key={tool.id} to={tool.path} className="tools-entry-card">
              {content}
            </Link>
          ) : (
            <div key={tool.id} className="tools-entry-card is-disabled" aria-disabled="true">
              {content}
            </div>
          );
        })}
      </section>
    </div>
  );
}
