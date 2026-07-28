import { useParams } from 'react-router-dom';
import { Seo } from '../../components/Seo';
import { ImageDetailPage } from './ImageDetailPage';

export function ImageDetailWrapper() {
  const { id } = useParams<{ id: string }>();
  return (
    <>
      <Seo title="作品详情" description="查看绘图姬 DrawHime 公开 AI 图片或视频作品、提示词摘要和生成信息。" path={`/image/${id ?? ''}`} />
      <ImageDetailPage key={id} />
    </>
  );
}
