/** 本文件登记用户端工具入口，后续新增工具只需要扩展此注册表和独立工具目录。 */
import type { ToolId } from '@aiimage/shared-contracts';

/** 用户端工具入口定义。 */
export interface ToolEntry {
  /** 工具稳定 ID；工作台使用独立入口 ID。 */
  id: ToolId | 'workbench';
  /** 需要读取 backend 工具开关时填写对应 ToolId。 */
  configId?: ToolId;
  /** 工具子页面路径。 */
  path: string;
  /** 用户可见名称。 */
  title: string;
  /** 工具用途短描述。 */
  description: string;
  /** 当前工具分类。 */
  category: string;
}

/** 用户端工具注册表。 */
export const toolEntries: ToolEntry[] = [
  {
    id: 'workbench',
    path: '/workbench',
    title: 'Agent 工作台',
    description: '在持久化上下文中与绘图 Agent 对话、规划方案并提交真实绘图任务。',
    category: 'AI 创作',
  },
  {
    id: 'image-splitter',
    configId: 'image-splitter',
    path: '/tools/image-splitter',
    title: '图片拆分',
    description: '上传一张图片，按行列切成多张 PNG，并打包下载。',
    category: '图片处理',
  },
  {
    id: 'image-converter',
    configId: 'image-converter',
    path: '/tools/image-converter',
    title: '格式转换与压缩',
    description: '批量转换 PNG、JPEG、WebP，并按质量、尺寸或目标体积压缩。',
    category: '图片处理',
  },
  {
    id: 'image-scrambler',
    configId: 'image-scrambler',
    path: '/tools/image-scrambler',
    title: '图片混淆',
    description: '上传一张图片，一键按空间填充曲线混淆或解混淆。',
    category: '图片处理',
  },
  {
    id: 'image-wobble',
    configId: 'image-wobble',
    path: '/tools/image-wobble',
    title: '局部抖动',
    description: '涂出需要活动的区域，制作柔软弹跳、漂浮或颤动动画。',
    category: '动态效果',
  },
  {
    id: 'image-reverse',
    configId: 'image-reverse',
    path: '/reverse',
    title: '图片反推',
    description: '上传一张图片，用识图模型提取风格、构图和可复用提示词。',
    category: 'AI 辅助',
  },
  {
    id: 'image-upscale',
    configId: 'image-upscale',
    path: '/tools/image-upscale',
    title: '图片放大',
    description: '上传一张图片，调用本地 GPU 超分模型放大并增强细节。',
    category: '图片处理',
  },
  {
    id: 'lora-captioning',
    path: '/tools/lora-captioning',
    title: 'LoRA 训练打标',
    description: '创建训练集、批量自动打标、翻译和整理标签，并联动本地 LoRA 训练。',
    category: '模型训练',
  },
];
