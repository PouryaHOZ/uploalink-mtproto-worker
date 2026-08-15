import { Env, TransferRequest, Platform } from '../types';
import { KVService } from '../services/kv';
import { Messenger } from '../platforms/messenger';
import { formatBytes } from '../utils/helpers';
import { QuotaService } from '../services/quota';

/**
 * Dynamically estimate transfer metrics for compression choices
 * Calculates based on ACTUAL file properties, not hardcoded values
 * 
 * @param fileSize - Original file size in bytes
 * @param isVideo - Whether this is a video file
 * @param videoMetadata - Optional video metadata (resolution, duration, bitrate)
 * @returns Object with time/size estimates for both options
 */
function estimateTransferMetrics(
    fileSize: number, 
    isVideo: boolean,
    videoMetadata?: {
        width?: number;
        height?: number;
        durationSeconds?: number;
        bitrate?: number;
        codec?: string;
        hasAudio?: boolean;
    }
) {
    // ===== DYNAMIC SPEED CALCULATIONS =====
    // Base speeds adjusted by file size (larger files often transfer slower due to overhead)
    const sizeFactor = Math.min(2, Math.max(0.5, fileSize / (100 * 1024 * 1024))); // Normalized around 100MB
    
    // Dynamic download speed: varies 3-8 MB/s based on typical Telegram performance
    // Smaller files tend to have higher effective throughput
    const baseDownloadSpeed = 5 * 1024 * 1024; // 5 MB/s baseline
    const avgDownloadSpeed = baseDownloadSpeed * (1.5 / sizeFactor); // Adjust for size
    
    // Dynamic upload speed: varies 8-15 MB/s based on MinIO/network conditions
    const baseUploadSpeed = 10 * 1024 * 1024; // 10 MB/s baseline
    const avgUploadSpeed = baseUploadSpeed * (1.2 / Math.sqrt(sizeFactor));
    
    if (!isVideo) {
        // Non-video: just direct transfer, no compression option
        const transferTime = fileSize / Math.min(avgDownloadSpeed, avgUploadSpeed);
        return {
            standard: {
                estimatedSize: fileSize,
                estimatedTimeSeconds: transferTime,
                sizeSavings: 0,
                sizeSavingsPercent: 0
            },
            compressed: null
        };
    }
    
    // ===== DYNAMIC VIDEO COMPRESSION CALCULATIONS =====
    
    // Extract video properties with sensible defaults if metadata unavailable
    const width = videoMetadata?.width || 1920; // Assume Full HD if unknown
    const height = videoMetadata?.height || 1080;
    const duration = videoMetadata?.durationSeconds || (fileSize / (2 * 1024 * 1024)); // Estimate ~2MB/s for video
    const sourceBitrate = videoMetadata?.bitrate || (fileSize * 8 / duration); // Calculate if not provided
    const hasAudio = videoMetadata?.hasAudio ?? true;
    
    // Source resolution
    const maxSourceDim = Math.max(width, height);
    
    // ===== DYNAMIC RESOLUTION OPTIONS BASED ON SOURCE =====
    // Determine output resolutions based on SOURCE video resolution
    let stdMaxDim: number;  // Standard option max dimension
    let compMaxDim: number; // Compressed option max dimension
    let stdLabel: string;   // Label for standard option
    let compLabel: string;  // Label for compressed option
    
    if (maxSourceDim >= 1280) {
        // Source is 720p or higher → Offer 720p and 480p
        stdMaxDim = 720;
        compMaxDim = 480;
        stdLabel = 'استاندارد (720p)';
        compLabel = 'سبک (480p)';
    } else if (maxSourceDim >= 854) {
        // Source is 480p-719p range → Offer 480p and 360p
        stdMaxDim = 480;
        compMaxDim = 360;
        stdLabel = 'استاندارد (480p)';
        compLabel = 'سبک (360p)';
    } else if (maxSourceDim >= 640) {
        // Source is 360p-479p range → Offer 360p and 240p
        stdMaxDim = 360;
        compMaxDim = 240;
        stdLabel = 'استاندارد (360p)';
        compLabel = 'سبک (240p)';
    } else {
        // Source is very small (< 360p) → Keep original or slight reduction
        stdMaxDim = maxSourceDim; // No downscale for standard
        compMaxDim = Math.max(240, Math.round(maxSourceDim * 0.67)); // ~2/3 of original
        stdLabel = `اصلی (${maxSourceDim}p)`;
        compLabel = `فشرده (${compMaxDim}p)`;
    }
    
    console.log(`[Estimation] Source: ${width}x${height} → Options: ${stdLabel} / ${compLabel}`);
    
    // Calculate total pixels (affects compression efficiency)
    const totalPixels = width * height;
    
    // ===== STANDARD OPTION CALCULATIONS =====
    const stdScaleFactor = Math.min(1, stdMaxDim / Math.max(width, height));
    const stdWidth = Math.round(width * stdScaleFactor);
    const stdHeight = Math.round(height * stdScaleFactor);
    const stdTotalPixels = stdWidth * stdHeight;
    
    // Target bitrate for standard option: varies by target resolution
    // Higher resolutions need more bits for quality
    const stdBitratePerPixel = stdMaxDim >= 720 ? 8 : (stdMaxDim >= 480 ? 6 : 4);
    const stdTargetBitrate = Math.min(
        stdMaxDim >= 720 ? 4000000 : (stdMaxDim >= 480 ? 2000000 : 1000000),
        Math.max(
            stdMaxDim >= 720 ? 1500000 : (stdMaxDim >= 480 ? 800000 : 400000),
            stdTotalPixels * stdBitratePerPixel
        )
    );
    
    // Audio bitrate (if present)
    const stdAudioBitrate = hasAudio ? 128000 : 0; // 128 kbps for standard audio
    
    // Calculate estimated output size
    const stdVideoBitrate = Math.min(sourceBitrate * 0.7, stdTargetBitrate); // Don't exceed 70% of source or target
    const stdEstimatedSize = Math.floor((stdVideoBitrate + stdAudioBitrate) * duration / 8);
    
    // FFmpeg processing speed for light optimization
    // Depends on: resolution change needed, codec complexity, hardware acceleration potential
    const stdResolutionChange = 1 - stdScaleFactor; // How much scaling (0 = none, 1 = max)
    const stdFfmpegSpeedBase = 10 * 1024 * 1024; // 10 MB/s baseline for light work
    const stdFfmpegSpeed = stdFfmpegSpeedBase * (1 - stdResolutionChange * 0.3); // Slower if more scaling needed
    
    // Total time for standard option
    const stdDownloadTime = fileSize / avgDownloadSpeed;
    const stdFfmpegTime = fileSize / stdFfmpegSpeed;
    const stdUploadTime = stdEstimatedSize / avgUploadSpeed;
    const stdTotalTime = stdDownloadTime + stdFfmpegTime + stdUploadTime;
    
    // ===== COMPRESSED OPTION CALCULATIONS =====
    const compScaleFactor = Math.min(1, compMaxDim / Math.max(width, height));
    const compWidth = Math.round(width * compScaleFactor);
    const compHeight = Math.round(height * compScaleFactor);
    const compTotalPixels = compWidth * compHeight;
    
    // Target bitrate for compressed option: varies by target resolution
    const compBitratePerPixel = compMaxDim >= 480 ? 6 : (compMaxDim >= 360 ? 4 : 3);
    const compTargetBitrate = Math.min(
        compMaxDim >= 480 ? 1500000 : (compMaxDim >= 360 ? 1000000 : 500000),
        Math.max(
            compMaxDim >= 480 ? 500000 : (compMaxDim >= 360 ? 300000 : 200000),
            compTotalPixels * compBitratePerPixel
        )
    );
    
    // Audio bitrate (lower for compressed version)
    const compAudioBitrate = hasAudio ? 64000 : 0; // 64 kbps for compressed audio
    
    // Calculate estimated output size
    const compVideoBitrate = Math.min(sourceBitrate * 0.4, compTargetBitrate); // More aggressive compression
    const compEstimatedSize = Math.floor((compVideoBitrate + compAudioBitrate) * duration / 8);
    
    // FFmpeg processing speed for heavy compression
    // Heavier compression takes longer due to more complex encoding
    const compResolutionChange = 1 - compScaleFactor;
    const compCompressionRatio = fileSize / compEstimatedSize; // How much we're compressing
    const compFfmpegSpeedBase = 4 * 1024 * 1024; // 4 MB/s baseline for heavy work
    // Slower for: bigger resolution changes, higher compression ratios
    const compFfmpegSpeed = compFfmpegSpeedBase * (1 - compResolutionChange * 0.4) * (1 / Math.sqrt(compCompressionRatio / 3));
    
    // Total time for compressed option
    const compDownloadTime = fileSize / avgDownloadSpeed; // Same download time
    const compFfmpegTime = fileSize / compFfmpegSpeed; // Longer processing
    const compUploadTime = compEstimatedSize / avgUploadSpeed; // Faster upload (smaller file)
    const compTotalTime = compDownloadTime + compFfmpegTime + compUploadTime;
    
    // ===== RELATIVE COMPARISON =====
    const speedRatio = stdTotalTime / compTotalTime;
    const fasterOption = speedRatio > 1 ? 'compressed' : 'standard';
    const speedMultiplier = Math.max(speedRatio, 1 / speedRatio);
    
    return {
        standard: {
            estimatedSize: stdEstimatedSize,
            estimatedTimeSeconds: stdTotalTime,
            sizeSavings: fileSize - stdEstimatedSize,
            sizeSavingsPercent: Math.round((1 - stdEstimatedSize / fileSize) * 100),
            label: stdLabel,
            details: {
                resolution: `${stdWidth}x${stdHeight}`,
                targetBitrate: stdVideoBitrate,
                maxDim: stdMaxDim
            }
        },
        compressed: {
            estimatedSize: compEstimatedSize,
            estimatedTimeSeconds: compTotalTime,
            sizeSavings: fileSize - compEstimatedSize,
            sizeSavingsPercent: Math.round((1 - compEstimatedSize / fileSize) * 100),
            label: compLabel,
            details: {
                resolution: `${compWidth}x${compHeight}`,
                targetBitrate: compVideoBitrate,
                maxDim: compMaxDim
            }
        },
        comparison: {
            fasterOption,
            speedMultiplier: parseFloat(speedMultiplier.toFixed(1)),
            timeDifferenceSeconds: Math.abs(stdTotalTime - compTotalTime),
            calculations: {
                sourceResolution: `${width}x${height}`,
                sourceBitrate: Math.round(sourceBitrate / 1000), // kbps
                estimatedDuration: Math.round(duration), // seconds
                optionsProvided: { standard: stdLabel, compressed: compLabel }
            }
        },
        debug: {
            inputFileSize: fileSize,
            assumedDuration: Math.round(duration),
            assumedSourceBitrate: Math.round(sourceBitrate / 1000) // kbps
        }
    };
}

export function createTransferRequest(messageId: string, chatId: string, userId: string, rawMessage: any, platform: Platform): TransferRequest {
    // Extract video metadata for dynamic estimations (if available)
    const videoMetadata = {
        width: rawMessage.video?.width || rawMessage.document?.width,
        height: rawMessage.video?.height || rawMessage.document?.height,
        durationSeconds: rawMessage.video?.duration || rawMessage.document?.duration,
        hasAudio: !(rawMessage.video?.has_audio === false || rawMessage.document?.has_audio === false)
    };
    
    return {
        messageId,
        chatId,
        fileName: rawMessage.document?.file_name || rawMessage.file?.file_name || `file_${messageId}_${Date.now()}`,
        fileSize: rawMessage.document?.file_size || rawMessage.video?.file_size || rawMessage.file?.size || 0,
        isVideo: !!rawMessage.document?.mime_type?.startsWith('video/') || !!rawMessage.video || !!rawMessage.file?.file_name?.endsWith('.mp4'),
        mimeType: rawMessage.document?.mime_type || rawMessage.video?.mime_type || rawMessage.file?.mimeType,
        userId,
        platform,
        videoMetadata // Include video metadata in the request
    };
}

export async function processFileTransfer(env: Env, kv: KVService, messenger: Messenger, transferRequest: TransferRequest): Promise<void> {
    // ===== Early File Size Validation =====
    // Check file size limits BEFORE any processing or quota reservation
    // This catches oversized files immediately and provides clear feedback
    if (transferRequest.fileSize > 0 && transferRequest.userId) {
        const quotaService = new QuotaService(env);
        const limits = await quotaService.getEffectiveLimits(transferRequest.userId);

        // Check per-file size limit (shared tier: 2GB max per file)
        if (limits.perFileLimitBytes > 0 && transferRequest.fileSize > limits.perFileLimitBytes) {
            await messenger.sendMessage(
                transferRequest.chatId,
                `❌ <b>حجم فایل بیش از حد مجاز است.</b>\n\n` +
                `📏 <b>حجم فایل شما:</b> ${formatBytes(transferRequest.fileSize)}\n` +
                `📊 <b>حداکثر مجاز:</b> ${formatBytes(limits.perFileLimitBytes)}\n\n` +
                `💡 لطفاً فایل کوچک‌تری ارسال کنید یا از قابلیت فشرده‌سازی ویدیو استفاده کنید.`,
                { inline_keyboard: [[{ text: '💎 اطلاعات اشتراک', callback_data: 'sub_status' }]] }
            );
            return;
        }

        // Warn for very large files (even if under limit)
        const LARGE_FILE_WARNING = 1.5 * 1024 * 1024 * 1024; // 1.5GB
        if (transferRequest.fileSize > LARGE_FILE_WARNING && limits.tier === 'trial') {
            await messenger.sendMessage(
                transferRequest.chatId,
                `⚠️ <b>توجه: حجم فایل زیاد است</b>\n\n` +
                `این فایل (${formatBytes(transferRequest.fileSize)}) نیمی از سهمیه روزانه آزمایشی شما را اشغال می‌کند.\n\n` +
                `💡 پیشنهاد: با خرید اشتراک، سهمیه روزانه خود را به ۵ گیگابایت افزایش دهید.`,
                { inline_keyboard: [[{ text: '💎 خرید اشتراک', callback_data: 'sub_buy' }]] }
            );
            // Don't return - let the user decide to continue
        }
    }

    // ===== Quota Gate =====
    // Check user's daily quota and reserve bytes atomically before allowing the transfer.
    // If quota is exceeded or file is too large, deny the transfer with a helpful message.
    if (transferRequest.userId) {
        const quotaService = new QuotaService(env);
        const quotaCheck = await quotaService.checkAndReserve(transferRequest);
        if (!quotaCheck.allowed) {
            const reason = quotaCheck.reason || 'unknown';
            let errorMsg = '❌ <b>انتقال فایل امکان‌پذیر نیست.</b>\n\n';

            if (reason === 'file_too_large') {
                const fileSize = quotaCheck.details?.fileSize || transferRequest.fileSize;
                const perFileLimit = quotaCheck.details?.perFileLimit || 0;
                errorMsg +=
                    `📦 <b>حجم فایل بیش از حد مجاز است.</b>\n` +
                    `• حجم فایل شما: ${formatBytes(fileSize)}\n` +
                    `• حداکثر مجاز هر فایل: ${formatBytes(perFileLimit)}\n\n` +
                    `💡 برای انتقال فایل‌های بزرگ‌تر، اشتراک اشتراکی را تهیه کنید.`;
            } else if (reason === 'quota_exceeded') {
                const dailyLimit = quotaCheck.details?.dailyLimit || 0;
                errorMsg +=
                    `📊 <b>سهمیه روزانه شما تکمیل شده است.</b>\n` +
                    `• سهمیه روزانه: ${formatBytes(dailyLimit)}\n\n` +
                    `💡 سهمیه هر روز ساعت ۰۰:۰۰ (به وقت تهران) بازنشانی می‌شود.\n` +
                    `برای دریافت سهمیه بیشتر: /subscribe`;
            }

            await messenger.sendMessage(
                transferRequest.chatId,
                errorMsg,
                { inline_keyboard: [[{ text: '💎 خرید اشتراک', callback_data: `sub_buy` }]] }
            );
            return;
        }
    }

    const transferId = `TR${Date.now()}`;
    await kv.saveTransferRequest(transferId, transferRequest);

    const inline_keyboard: any[][] = [];

    if (transferRequest.isVideo) {
        // Use video metadata from transferRequest (extracted during createTransferRequest)
        const videoMetadata = transferRequest.videoMetadata;
        
        // Calculate transfer estimates with ACTUAL video properties
        const metrics = estimateTransferMetrics(transferRequest.fileSize, true, videoMetadata);
        const std = metrics.standard;
        const comp = metrics.compressed!;
        const comparison = metrics.comparison!; // Non-null assertion for video files
        
        // Format time in human-readable relative format
        const formatRelativeTime = (seconds: number): string => {
            if (seconds < 60) return `${Math.round(seconds)} ثانیه`;
            if (seconds < 3600) return `${Math.round(seconds / 60)} دقیقه`;
            return `${(seconds / 3600).toFixed(1)} ساعت`;
        };
        
        // Build speed comparison text
        const speedComparisonText = comparison.fasterOption === 'compressed' 
            ? `⚡ <b>${comparison.speedMultiplier}x سریع‌تر</b> از گزینه استاندارد`
            : `⚡ <b>${comparison.speedMultiplier}x سریع‌تر</b> از گزینه سبک`;
        
        const fasterBadge = comparison.fasterOption === 'compressed' ? '🏆' : '';
        const standardBadge = comparison.fasterOption === 'standard' ? '🏆' : '';
        
        const messageText = `🎬 <b>دریافت ویدیو:</b> ${transferRequest.fileName}\n` +
                            `📏 <b>حجم اصلی:</b> ${formatBytes(transferRequest.fileSize)}\n` +
                            `📐 <b>کیفیت منبع:</b> ${comparison.calculations.sourceResolution}\n\n` +
                            `📊 <b>برآورد حجم خروجی:</b>\n\n` +
                            `${fasterBadge} 🔹 <b>${std.label}</b>\n` +
                            `   📦 حجم خروجی: ~${formatBytes(std.estimatedSize)} (-${std.sizeSavingsPercent}%)\n\n` +
                            `${standardBadge} 🔸 <b>${comp.label}</b>\n` +
                            `   📦 حجم خروجی: ~${formatBytes(comp.estimatedSize)} (-${comp.sizeSavingsPercent}%)\n` +
                            `   ${speedComparisonText}\n\n` +
                            `لطفاً کیفیت خروجی را انتخاب کنید:`;

        inline_keyboard.push([{ text: `🔹 ${std.label}`, callback_data: `link_gen:no:${transferId}` }]);
        inline_keyboard.push([{ text: `🔸 ${comp.label}`, callback_data: `link_gen:yes:${transferId}` }]);

        await messenger.sendMessage(transferRequest.chatId, messageText, { inline_keyboard });
    } else {
        const messageText = `📁 <b>دریافت فایل:</b> ${transferRequest.fileName}\n` +
                            `⚖️ <b>حجم:</b> ${formatBytes(transferRequest.fileSize)}\n\n` +
                            `لطفاً عملیات مورد نظر را انتخاب کنید:`;

        inline_keyboard.push([{ text: '🔗 ساخت لینک دانلود مستقیم', callback_data: `link_gen:no:${transferId}` }]);
        await messenger.sendMessage(transferRequest.chatId, messageText, { inline_keyboard });
    }
}
