/** 本文件集中保存独立本地模型平台管理端页面样式常量。 */
import type React from 'react';

/** 页面样式。 */
export const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  padding: '28px 24px 40px',
  background: 'linear-gradient(180deg, #f7f8fc 0%, #eef2f8 100%)',
  color: '#101828',
  fontFamily: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
};

/** 英文眉头。 */
export const eyebrowStyle: React.CSSProperties = {
  fontSize: 12,
  letterSpacing: 0.4,
  color: '#667085',
  fontWeight: 700,
};

/** 标题。 */
export const titleStyle: React.CSSProperties = {
  margin: '8px 0 10px',
  fontSize: 34,
  lineHeight: 1.1,
  fontWeight: 800,
};

/** 说明。 */
export const leadStyle: React.CSSProperties = {
  margin: 0,
  maxWidth: 780,
  fontSize: 15,
  lineHeight: 1.7,
  color: '#475467',
};

/** 顶部操作区。 */
export const heroActionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'center',
};

/** 顶部。 */
export const heroStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 20,
  alignItems: 'end',
  marginBottom: 20,
};

/** 错误提示。 */
export const alertStyle: React.CSSProperties = {
  border: '1px solid #f2b8b5',
  background: '#fff1f0',
  color: '#b42318',
  borderRadius: 8,
  padding: 12,
  marginBottom: 16,
};

/** 统计网格。 */
export const statsGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
  gap: 12,
  marginBottom: 20,
};

/** 就绪状态网格。 */
export const readinessGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  gap: 12,
  marginBottom: 20,
};

/** 已就绪状态项。 */
export const readinessItemReadyStyle: React.CSSProperties = {
  border: '1px solid #b7dfc0',
  borderRadius: 8,
  background: '#f1fbf3',
  padding: '12px 14px',
};

/** 未就绪状态项。 */
export const readinessItemWarnStyle: React.CSSProperties = {
  border: '1px solid #f7c8a3',
  borderRadius: 8,
  background: '#fff7ed',
  padding: '12px 14px',
};

/** 就绪项标签。 */
export const readinessLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#667085',
};

/** 就绪项状态。 */
export const readinessValueStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 18,
  fontWeight: 800,
};

/** 就绪项说明。 */
export const readinessDetailStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 12,
  color: '#475467',
};

/** 统计卡片。 */
export const statStyle: React.CSSProperties = {
  border: '1px solid #d0d5dd',
  borderRadius: 8,
  background: '#fff',
  padding: '14px 16px',
};

/** 统计标签。 */
export const statLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#667085',
  marginBottom: 8,
};

/** 统计值。 */
export const statValueStyle: React.CSSProperties = {
  fontSize: 26,
  lineHeight: 1,
  fontWeight: 800,
};

/** 双栏。 */
export const contentGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.15fr 0.85fr',
  gap: 16,
  alignItems: 'start',
};

/** 底部双栏。 */
export const bottomGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.1fr 0.9fr',
  gap: 16,
  alignItems: 'start',
  marginTop: 16,
};

/** 面板。 */
export const panelStyle: React.CSSProperties = {
  border: '1px solid #d0d5dd',
  borderRadius: 8,
  background: '#fff',
  padding: 16,
};

/** 面板头。 */
export const panelHeaderStyle: React.CSSProperties = {
  marginBottom: 12,
};

/** 面板标题。 */
export const panelTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
};

/** 面板副标题。 */
export const panelSubtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#667085',
  marginTop: 4,
};

/** 字段。 */
export const fieldStyle: React.CSSProperties = {
  marginTop: 12,
};

/** 字段标签。 */
export const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: '#667085',
  marginBottom: 6,
};

/** 输入。 */
export const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid #d0d5dd',
  boxSizing: 'border-box',
  background: '#fff',
  color: '#101828',
};

/** 映射列表。 */
export const mappingListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
};

/** 映射行。 */
export const mappingRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1.6fr 0.8fr 110px 72px',
  gap: 8,
  alignItems: 'center',
};

/** 运行器配置网格。 */
export const executorGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 10,
  alignItems: 'end',
};

/** 复选标签。 */
export const checkLabelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
  color: '#344054',
};

/** 目录区标题。 */
export const sectionLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: '#475467',
  marginBottom: 8,
};

/** 工具条。 */
export const toolbarStyle: React.CSSProperties = {
  marginTop: 12,
  display: 'flex',
  gap: 8,
};

/** 按钮。 */
export const buttonStyle: React.CSSProperties = {
  padding: '10px 14px',
  border: '1px solid #d0d5dd',
  borderRadius: 8,
  background: '#fff',
  color: '#101828',
  cursor: 'pointer',
};

/** 主要按钮。 */
export const buttonPrimaryStyle: React.CSSProperties = {
  ...buttonStyle,
  background: '#111827',
  borderColor: '#111827',
  color: '#fff',
};

/** 次要按钮。 */
export const ghostButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  padding: '10px 10px',
};

/** 代码块。 */
export const codeStyle: React.CSSProperties = {
  display: 'block',
  padding: 12,
  borderRadius: 8,
  background: '#f2f4f7',
  border: '1px solid #eaecf0',
  fontSize: 12,
  overflowX: 'auto',
};

/** 目录卡片网格。 */
export const dirGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 10,
};

/** 目录卡片。 */
export const dirCardStyle: React.CSSProperties = {
  border: '1px solid #eaecf0',
  borderRadius: 8,
  padding: 12,
  background: '#fcfcfd',
};

/** 目录标题。 */
export const dirTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  marginBottom: 4,
};

/** 目录元信息。 */
export const dirMetaStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#667085',
};

/** 等宽文本块。 */
export const monoListStyle: React.CSSProperties = {
  padding: 12,
  borderRadius: 8,
  background: '#f9fafb',
  border: '1px solid #eaecf0',
  fontSize: 12,
  lineHeight: 1.6,
  color: '#344054',
};

/** 列表。 */
export const listStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
};

/** 行卡。 */
export const rowStyle: React.CSSProperties = {
  border: '1px solid #eaecf0',
  borderRadius: 8,
  padding: 12,
  background: '#fcfcfd',
};

/** 行头。 */
export const rowHeadStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
};

/** 已发现状态。 */
export const statusReadyStyle: React.CSSProperties = {
  flex: '0 0 auto',
  alignSelf: 'start',
  borderRadius: 999,
  padding: '3px 8px',
  background: '#dcfae6',
  color: '#067647',
  fontSize: 12,
  fontWeight: 700,
};

/** 缺失状态。 */
export const statusMissingStyle: React.CSSProperties = {
  ...statusReadyStyle,
  background: '#ffead5',
  color: '#b54708',
};

/** 行标题。 */
export const rowTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  marginBottom: 2,
};

/** 行元信息。 */
export const rowMetaStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#667085',
};

/** 标签容器。 */
export const tagWrapStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 10,
};

/** 标签。 */
export const tagStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '3px 8px',
  borderRadius: 999,
  background: '#eef4ff',
  color: '#3538cd',
  fontSize: 12,
  fontWeight: 600,
};

/** 行备注。 */
export const rowNoteStyle: React.CSSProperties = {
  marginTop: 10,
  fontSize: 12,
  lineHeight: 1.6,
  color: '#475467',
};

/** 摘要区。 */
export const summaryListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
};

/** 摘要项。 */
export const summaryItemStyle: React.CSSProperties = {
  border: '1px solid #eaecf0',
  borderRadius: 8,
  padding: 12,
  background: '#fcfcfd',
};

/** 摘要标签。 */
export const summaryLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#667085',
  marginBottom: 4,
};

/** 摘要值。 */
export const summaryValueStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#101828',
  lineHeight: 1.6,
  wordBreak: 'break-all',
};
