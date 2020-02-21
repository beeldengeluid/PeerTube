
import { spawn } from 'child_process'
import { ensureDir, readdir, remove } from 'fs-extra'
import { join } from 'path'
import { logger } from '@server/helpers/logger'
import { CONFIG } from '@server/initializers/config'
import { P2P_MEDIA_LOADER_PEER_VERSION, VIDEO_LIVE, WEBSERVER } from '@server/initializers/constants'
import { VideoFileModel } from '@server/models/video/video-file'
import { VideoLiveModel } from '@server/models/video/video-live'
import { VideoStreamingPlaylistModel } from '@server/models/video/video-streaming-playlist'
import { MStreamingPlaylist, MVideoLiveVideo, MVideoPlaylist, MVideo } from '@server/types/models'
import { VideoState, VideoStreamingPlaylistType } from '@shared/models'
import { getHLSDirectory } from './video-paths'

const NodeRtmpServer = require('node-media-server/node_rtmp_server')
const context = require('node-media-server/node_core_ctx')
const nodeMediaServerLogger = require('node-media-server/node_core_logger')

// Disable node media server logs
nodeMediaServerLogger.setLogType(0)

const config = {
  rtmp: {
    port: CONFIG.LIVE.RTMP.PORT,
    chunk_size: VIDEO_LIVE.RTMP.CHUNK_SIZE,
    gop_cache: VIDEO_LIVE.RTMP.GOP_CACHE,
    ping: VIDEO_LIVE.RTMP.PING,
    ping_timeout: VIDEO_LIVE.RTMP.PING_TIMEOUT
  },
  transcoding: {
    ffmpeg: 'ffmpeg'
  }
}

const ffmpegResolutionsMapping = {
  1080: {
    videoBitrate: '4000k',
    width: '1920',
    acParam: [ '-b:a', '192k', '-ar', 48000 ],
    vcParams: [ '-vf', 'scale=1920:-1', '-b:v', '5000k', '-preset', 'fast', '-profile:v', 'baseline', '-bufsize', '7500k' ]
  },

  720: {
    videoBitrate: '2500k',
    width: '1280',
    acParam: [ '-b:a', '128k', '-ar', 48000 ],
    vcParams: [ '-vf', 'scale=1280:-1', '-b:v', '2800k', '-preset', 'fast', '-profile:v', 'baseline', '-bufsize', '4200k' ]
  },

  480: {
    videoBitrate: '1400k',
    width: '842',
    acParam: [ '-b:a', '128k', '-ar', 48000 ],
    vcParams: [ '-vf', 'scale=854:-1', '-b:v', '1400k', '-preset', 'fast', '-profile:v', 'baseline', '-bufsize', '2100k' ]
  },

  360: {
    videoBitrate: '800k',
    width: '640',
    acParam: [ '-b:a', '96k', '-ar', 48000 ],
    vcParams: [ '-vf', 'scale=480:-1', '-b:v', '800k', '-preset', 'fast', '-profile:v', 'baseline', '-bufsize', '1200k' ]
  }
}

class LiveManager {

  private static instance: LiveManager

  private readonly transSessions = new Map()

  private constructor () {
  }

  run () {
    this.getContext().nodeEvent.on('postPublish', (sessionId, streamPath, args) => {
      logger.debug('RTMP received stream', { id: sessionId, streamPath, args })

      const splittedPath = streamPath.split('/')
      if (splittedPath.length !== 3 || splittedPath[1] !== VIDEO_LIVE.RTMP.BASE_PATH) {
        logger.warn('Live path is incorrect.', { streamPath })
        return this.abortSession(sessionId)
      }

      this.handleSession(sessionId, streamPath, splittedPath[2])
        .catch(err => logger.error('Cannot handle sessions.', { err }))
    })

    this.getContext().nodeEvent.on('donePublish', sessionId => {
      const session = this.transSessions.get(sessionId)

      if (session) session.end()
    })

    const rtmpServer = new NodeRtmpServer(config)
    rtmpServer.run()
  }

  private getContext () {
    return context
  }

  private abortSession (id: string) {
    const session = this.getContext().sessions.get(id)
    if (session) session.stop()
  }

  private async handleSession (sessionsId: string, streamPath: string, streamKey: string) {
    const videoLive = await VideoLiveModel.loadByStreamKey(streamKey)
    if (!videoLive) {
      logger.warn('Unknown live video with stream key %s.', streamKey)
      return this.abortSession(sessionsId)
    }

    const video = videoLive.Video
    const playlistUrl = WEBSERVER.URL + VideoStreamingPlaylistModel.getHlsMasterPlaylistStaticPath(video.uuid)

    const [ videoStreamingPlaylist ] = await VideoStreamingPlaylistModel.upsert({
      videoId: videoLive.Video.id,
      playlistUrl,
      segmentsSha256Url: WEBSERVER.URL + VideoStreamingPlaylistModel.getHlsSha256SegmentsStaticPath(videoLive.Video.uuid),
      p2pMediaLoaderInfohashes: [],
      p2pMediaLoaderPeerVersion: P2P_MEDIA_LOADER_PEER_VERSION,

      type: VideoStreamingPlaylistType.HLS
    }, { returning: true }) as [ MStreamingPlaylist, boolean ]

    video.state = VideoState.PUBLISHED
    await video.save()

    // FIXME: federation?

    return this.runMuxing(videoLive, videoStreamingPlaylist, streamPath)
  }

  private async runMuxing (videoLive: MVideoLiveVideo, playlist: MStreamingPlaylist, streamPath: string) {
    const inPath = 'rtmp://127.0.0.1:' + config.rtmp.port + streamPath

    const outPath = getHLSDirectory(videoLive.Video)
    await ensureDir(outPath)

    let argv: string[] = [ '-y', '-fflags', 'nobuffer', '-i', inPath ]

    const varStreamMap: string[] = []

    // FIXME: todo
    const resolutions = [ 1080, 480, 360 ]

    let filterComplex = '[v:0]split=' + resolutions.length
    for (let i = 0; i < resolutions.length; i++) {
      const resolution = resolutions[i]

      VideoFileModel.create({
        resolution,
        size: -1,
        extname: '.ts',
        infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaeeeeaaaaaaaa',
        fps: -1,
        videoStreamingPlaylistId: playlist.id
      }).catch(err => {
        logger.error('Cannot create file for live streaming.', { err })
      })

      filterComplex += `[vtemp00${i}]`
    }

    for (let i = 0; i < resolutions.length; i++) {
      const resolution = resolutions[i]
      const ffmpegOptions = ffmpegResolutionsMapping[resolution]

      filterComplex += `;[vtemp00${i}]scale=w=${ffmpegOptions.width}:h=${resolution}:force_original_aspect_ratio=decrease[vout00${i}]`
    }

    argv = argv.concat([
      '-filter_complex', `${filterComplex}`
    ])

    argv = argv.concat([
      '-r', '30',
      '-g', '60',
      '-keyint_min', '60',
      '-preset', 'superfast',
      '-pix_fmt', 'yuv420p'
    ])

    for (let i = 0; i < resolutions.length; i++) {
      const resolution = resolutions[i]
      const ffmpegOptions = ffmpegResolutionsMapping[resolution]

      argv = argv.concat([
        '-map', `[vout00${i}]`,
        `-c:v:${i}`, 'libx264',
        `-b:v:${i}`, ffmpegOptions.videoBitrate,
        '-map', 'a:0',
        `-c:a:${i}`, 'aac',
        `-b:a:${i}`, '128k'
      ])

      varStreamMap.push(`v:${i},a:${i}`)
    }

    argv = argv.concat([
      '-hls_time', '4',
      '-hls_list_size', '15',
      '-hls_flags', 'delete_segments',
      '-hls_segment_filename', join(outPath, '%v-%d.ts'),
      '-master_pl_name', 'master.m3u8',
      '-var_stream_map', varStreamMap.join(' ')
    ])

    argv = argv.concat([
      '-f', 'hls', join(outPath, '%v.m3u8')
    ])

    logger.info('Running live muxing.', { argv: argv.join(' ') })

    const ffmpegExec = spawn(config.transcoding.ffmpeg, argv)

    ffmpegExec.on('error', e => logger.error(e))

    ffmpegExec.stdout.on('data', (data) => logger.debug(data))
    ffmpegExec.stderr.on('data', (data) => logger.debug(data))

    ffmpegExec.on('close', () => {
      this.onEndTransmuxing(videoLive.Video, playlist, streamPath, outPath)
        .catch(err => logger.error('Error in closed transmuxing.', { err }))
    })
  }

  private async onEndTransmuxing (video: MVideo, playlist: MStreamingPlaylist, streamPath: string, outPath: string,) {
    logger.info('RTMP transmuxing for %s ended.', streamPath)

    const files = await readdir(outPath)

    for (const filename of files) {
      if (
        filename.endsWith('.ts') ||
        filename.endsWith('.m3u8') ||
        filename.endsWith('.mpd') ||
        filename.endsWith('.m4s') ||
        filename.endsWith('.tmp')
      ) {
        const p = outPath + '/' + filename

        remove(p)
          .catch(err => logger.error('Cannot remove %s.', p, { err }))
      }
    }

    playlist.destroy()
      .catch(err => logger.error('Cannot remove live streaming playlist.', { err }))

    video.state = VideoState.LIVE_ENDED
    video.save()
      .catch(err => logger.error('Cannot save new video state of live streaming.', { err }))
  }

  static get Instance () {
    return this.instance || (this.instance = new this())
  }
}

// ---------------------------------------------------------------------------

export {
  LiveManager
}
