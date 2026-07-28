/**
 * 本文件提供全局错误处理工具：统一错误日志、未知错误脱敏、优雅关闭。
 * 所有服务端程序应该在 createHttpService 之前注入本处理器。
 */

/** 全局未捕获异常处理器，防止进程因未处理异常直接退出。 */
export function installGlobalErrorHandlers(): void {
  // 未捕获的 Promise rejection
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error('[global] unhandledRejection', message);
  });

  // 未捕获的同步异常
  process.on('uncaughtException', (error) => {
    console.error('[global] uncaughtException', error.message, error.stack?.split('\n').slice(1, 4).join(' | '));
    // 严重错误（如端口占用）应退出，可恢复错误记录后继续
    if (isFatalError(error)) {
      console.error('[global] fatal error, exiting');
      process.exit(1);
    }
  });

  // 优雅关闭
  process.on('SIGTERM', () => {
    console.log('[global] SIGTERM received, shutting down gracefully');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('[global] SIGINT received, shutting down gracefully');
    process.exit(0);
  });
}

/** 判断是否为应退出进程的致命错误。 */
function isFatalError(error: Error): boolean {
  const fatalCodes = ['EADDRINUSE', 'EACCES', 'ENOENT'];
  return fatalCodes.some((code) => (error as NodeJS.ErrnoException).code === code);
}
