/** 本文件定义 Web 用户头像接口契约；头像独立于 QQ 头像和 media-service 图片链路。 */

/** Web 用户头像上传成功后返回当前头像地址。 */
export type UserAvatarUploadResponse = {
  avatarUrl: string;
  filename: string;
};

/** Web 用户头像删除后恢复默认头像。 */
export type UserAvatarDeleteResponse = {
  avatarUrl: null;
};

/** 用户资料响应中的头像字段，供 /api/users/profile 复用。 */
export type UserProfileAvatarFields = {
  /** Web 用户自定义头像地址；为空时前端展示用户名首字母默认头像。 */
  avatarUrl: string | null;
};
