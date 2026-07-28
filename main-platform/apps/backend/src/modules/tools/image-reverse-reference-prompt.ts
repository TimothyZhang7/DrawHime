/** 本文件为反推描述模式构造可接收不定数量参考图的角色保留迁移提示词，隔离原图角色特征与可复用画面要求。 */
import type { ImageReverseDescriptionLanguageResultView, ImageReverseLanguage } from '@aiimage/shared-contracts';

/** 描述模式中可直接搭配一张或多张新角色参考图使用的提示词包。 */
export interface ImageReverseReferencePromptPair {
  /** 只迁移画面结构与视觉表现的正向提示词。 */
  drawingPrompt: string;
  /** 防止参考角色漂移和常见结构错误的反向提示词。 */
  negativePrompt: string;
}

/**
 * 从已经分栏的结构化描述中构造提示词。
 * 这里有意只读取 poseAndAction、composition、backgroundAtmosphere、colorLighting、style 和非角色 details，
 * 从数据流上排除脸、头发、眼睛、体型、服装、配饰和身份锚点等原角色特征。
 */
export function buildImageReverseReferencePrompt(
  result: ImageReverseDescriptionLanguageResultView,
  language: ImageReverseLanguage,
  maxLength: number,
): ImageReverseReferencePromptPair {
  const scene = compactSceneValues([
    result.character.poseAndAction,
    result.composition,
    result.backgroundAtmosphere,
    result.colorLighting,
    result.style,
    ...result.details.slice(0, 6),
  ]);
  const localized = buildLocalizedPrompt(language, scene);
  return {
    drawingPrompt: localized.drawingPrompt.slice(0, maxLength),
    negativePrompt: localized.negativePrompt.slice(0, maxLength),
  };
}

/** 按语言生成明确的参考图优先指令，任何语言都只引用字段值而不引用原角色外观。 */
function buildLocalizedPrompt(language: ImageReverseLanguage, scene: string[]): ImageReverseReferencePromptPair {
  if (language === 'zh' || language === 'zh-CN') {
    return {
      drawingPrompt: [
        '使用随本次生成请求附带的全部角色参考图作为角色身份和外观的唯一来源，参考图数量可以是一张或多张。多张图若展示同一角色，应当作为同一角色的不同角度、表情或细节证据合并理解，不得按图片数量复制角色；多张图若明确展示不同角色，应分别保持各自身份，禁止把多个角色融合成新角色。',
        '参考图中的角色外观优先于全部文字要求。完整保留参考角色的脸部、五官、发型发色、眼睛、肤色、体型比例、服装、配饰、随身道具及稳定辨识特征；只允许按照下文改变姿势、动作、镜头、环境、光影和画风。不得采用反推原图主角色的任何外观或设定，也不得依据文字重新设计、平均化或替换参考角色。',
        '在保持参考角色特征完全不变的前提下，只复现反推原图的以下画面要求：',
        ...scene,
        '最终画面中由参考图控制的主体角色数量，应由参考图内实际不同的角色身份决定，而不是由参考图张数决定。同一角色的多张参考图只生成该角色的一个实例；下文明确描述的陪伴生物、环境角色和场景物件仍按原图要求保留。主体角色以其原有特征呈现上述姿势、构图、背景、光影和画风。',
      ].join('\n'),
      negativePrompt: '参考图使用规则：同一角色的多张参考图仅用于补充不同视角和可见细节，不得生成与参考图张数相同的角色副本，不得把角度、光照、表情差异误判成不同身份；多张图存在清晰度差异时，以更清晰且在多图中一致的角色特征为准。生成约束：保持每个参考角色的身份、脸部、发型、眼睛、肤色、体型、服装、配饰和随身道具，排除反推原图主角色外观、角色融合、身份漂移、服装漂移、无依据新增角色、肢体结构错误、手部错误、多余手指、多余肢体、低质量、模糊、文字、水印和标志。',
    };
  }
  if (language === 'zh-TW') {
    return {
      drawingPrompt: [
        '使用本次生成請求附帶的全部角色參考圖作為角色身份與外觀的唯一來源，參考圖數量可以是一張或多張。多張圖若展示同一角色，應視為同一角色的不同角度、表情或細節證據，不得按圖片數量複製角色；若明確展示不同角色，應分別保持各自身份，禁止融合成新角色。',
        '參考圖中的角色外觀優先於全部文字要求。完整保留參考角色的臉部、五官、髮型髮色、眼睛、膚色、體型比例、服裝、配飾、隨身道具及穩定辨識特徵；只允許依照下文改變姿勢、動作、鏡頭、環境、光影與畫風。不得採用反推原圖主角色的外觀或設定，也不得以文字重新設計、平均化或替換參考角色。',
        '在保持參考角色特徵完全不變的前提下，只重現反推原圖的以下畫面要求：',
        ...scene,
        '最終畫面中由參考圖控制的主體角色數量，應由參考圖內實際不同的角色身份決定，而不是由參考圖張數決定。同一角色的多張參考圖只生成該角色的一個實例；下文明確描述的陪伴生物、環境角色與場景物件仍按原圖要求保留。主體角色以其原有特徵呈現上述姿勢、構圖、背景、光影與畫風。',
      ].join('\n'),
      negativePrompt: '參考圖使用規則：同一角色的多張參考圖僅用於補充不同視角與可見細節，不得生成與參考圖張數相同的角色副本，不得把角度、光照或表情差異誤判為不同身份；清晰度不同時，以較清晰且多圖一致的角色特徵為準。生成約束：保持每個參考角色的身份、臉部、髮型、眼睛、膚色、體型、服裝、配飾與隨身道具，排除反推原圖主角色外觀、角色融合、身份漂移、服裝漂移、無依據新增角色、肢體結構錯誤、手部錯誤、多餘手指、多餘肢體、低品質、模糊、文字、浮水印與標誌。',
    };
  }
  if (language === 'ja-JP') {
    return {
      drawingPrompt: [
        '生成リクエストに添付されたすべてのキャラクター参照画像を、身元と外見の唯一の情報源として使用する。画像が同じキャラクターを示す場合は、異なる角度や表情、細部の補足資料として統合理解し、画像枚数に応じてキャラクターを複製しない。明確に異なるキャラクターの場合は、それぞれの身元を保ち、融合しない。',
        '参照画像の外見情報をすべての文章指示より優先する。顔、髪、目、肌、体格、衣装、アクセサリー、携行小物、安定した識別特徴を維持し、以下の姿勢、動作、カメラ、環境、照明、画風だけを変更する。解析元画像の主キャラクター外見を取り込まず、文章で参照キャラクターを再設計、平均化、置換しない。',
        '参照キャラクターの特徴を変えずに、解析元画像から次の画面要素だけを再現する：',
        ...scene,
        '最終画像で参照画像が制御する主役キャラクター数は、参照画像内の実際に異なる身元で決め、画像枚数では決めない。同じキャラクターの複数画像からは一人分だけを生成する。以下で明示された随伴生物、環境キャラクター、場面の物体は元画像の要件どおり維持し、主役は元の特徴のまま上記のポーズ、構図、背景、照明、画風で描く。',
      ].join('\n'),
      negativePrompt: '参照画像の使用規則：同じキャラクターの複数画像は視点と可視情報を補うためだけに使い、画像枚数と同じ数の複製を生成せず、角度、照明、表情の違いを別人と解釈しない。鮮明さが異なる場合は、より鮮明で複数画像に一貫する特徴を優先する。生成制約：各参照キャラクターの身元、顔、髪、目、肌、体格、衣装、アクセサリー、小物を維持し、解析元主キャラクターの外見、キャラクター融合、同一性や衣装のずれ、根拠のない追加人物、人体構造や手の誤り、余分な指や手足、低品質、ぼやけ、文字、透かし、ロゴを排除する。',
    };
  }
  if (language === 'ko-KR') {
    return {
      drawingPrompt: [
        '생성 요청에 첨부된 모든 캐릭터 참고 이미지를 정체성과 외형의 유일한 출처로 사용한다. 여러 이미지가 같은 캐릭터를 보여 주면 서로 다른 각도, 표정, 세부 정보의 보충 자료로 통합하고 이미지 수만큼 캐릭터를 복제하지 않는다. 명확히 다른 캐릭터라면 각 정체성을 따로 유지하고 서로 융합하지 않는다.',
        '참고 이미지의 캐릭터 외형을 모든 텍스트 지시보다 우선한다. 얼굴, 이목구비, 머리, 눈, 피부, 체형, 의상, 장신구, 휴대 소품과 안정적인 식별 특징을 유지하며 아래의 자세, 동작, 카메라, 환경, 조명과 화풍만 변경한다. 역추적 원본의 주 캐릭터 외형을 가져오거나 텍스트로 참고 캐릭터를 재설계, 평균화, 교체하지 않는다.',
        '참고 캐릭터의 특징을 전혀 바꾸지 않은 상태에서 역추적 원본의 다음 화면 요소만 재현한다:',
        ...scene,
        '최종 이미지에서 참고 이미지가 제어하는 주체 캐릭터 수는 참고 이미지에 실제로 존재하는 서로 다른 정체성으로 결정하며 이미지 장수로 결정하지 않는다. 같은 캐릭터의 여러 참고 이미지에서는 그 캐릭터 한 명만 생성한다. 아래에 명시된 동반 생물, 환경 캐릭터와 장면 소품은 원본 요구대로 유지하며, 주체 캐릭터는 원래 특징을 보존한 채 위 자세, 구도, 배경, 조명과 화풍을 적용한다.',
      ].join('\n'),
      negativePrompt: '참고 이미지 사용 규칙: 같은 캐릭터의 여러 이미지는 시점과 보이는 세부 정보를 보충하는 용도로만 사용하고 이미지 수만큼 복제하지 않으며 각도, 조명, 표정 차이를 다른 정체성으로 해석하지 않는다. 선명도가 다르면 더 선명하고 여러 이미지에서 일관된 특징을 우선한다. 생성 제약: 각 참고 캐릭터의 정체성, 얼굴, 머리, 눈, 피부, 체형, 의상, 장신구와 소품을 유지하고 역추적 원본 주 캐릭터의 외형, 캐릭터 융합, 정체성 및 의상 드리프트, 근거 없는 추가 인물, 신체 및 손 구조 오류, 여분의 손가락과 팔다리, 저화질, 흐림, 문자, 워터마크, 로고를 배제한다.',
    };
  }
  return {
    drawingPrompt: [
      'Use all character reference images attached to the generation request as the only source of character identity and appearance; the number of images may vary. When several images show the same character, combine them as complementary evidence of different angles, expressions, or details and do not duplicate the character according to image count. When images clearly show different characters, preserve each identity separately and never blend them into a new character.',
      'Reference-image appearance takes priority over every textual instruction. Preserve each reference character’s face, facial features, hair, eyes, skin, body proportions, outfit, accessories, carried props, and stable identifying traits. Only pose, action, camera, environment, lighting, and visual style may change according to the requirements below. Do not import the reverse-engineered source image’s main-character appearance, and do not redesign, average, or replace a reference character through text.',
      'While keeping the reference character completely unchanged, reproduce only these visual requirements from the source image:',
      ...scene,
      'Determine the number of primary characters controlled by the references from the genuinely distinct identities visible in those references, never from the number of uploaded images. Multiple references of the same character must produce one instance of that character. Explicitly described companion creatures, environmental characters, and scene objects remain part of the source-image scene. Each primary character retains the original traits while adopting the pose, composition, background, lighting, and visual style listed above.',
    ].join('\n'),
    negativePrompt: 'Reference-image rules: multiple images of the same character only supplement viewpoints and visible details; do not create one character copy per image, and do not interpret angle, lighting, or expression differences as different identities. When clarity differs, prefer clearer traits that remain consistent across the references. Generation constraints: preserve each reference character’s identity, face, hair, eyes, skin, body shape, outfit, accessories, and carried props. Exclude the reverse-engineered source image’s main-character appearance, character blending, identity drift, outfit drift, unsupported extra characters, malformed anatomy or hands, extra fingers or limbs, low quality, blur, text, watermark, and logos.',
  };
}

/** 去除空值和完全重复的场景项，同时保留模型已经识别出的真实画面信息。 */
function compactSceneValues(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = value.trim();
    const key = text.replace(/\s+/g, ' ').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // 单项过长会挤掉后续构图、光影和画风要求；这里只裁剪已识别文本，不生成额外视觉事实。
    result.push(text.slice(0, 420));
  }
  return result;
}
