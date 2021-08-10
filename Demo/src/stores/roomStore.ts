import { observable, action, runInAction, computed } from 'mobx';
import {
  TrackModeSession,
  RoomState,
  User as RTCUser,
  Track as RTCTrack,
  TrackBaseInfo,
  RecordConfig,
  deviceManager,
  AudioTrack,
  TrackStatsReport,
  AudioUtils,
  TrackMergeOptions,
  MergeJob
} from 'pili-rtc-web';
import userStore from './userStore';
import { RTC_APP_ID } from '../common/api';
import User from '../models/User';
import Track from '../models/Track';
import groupBy from 'lodash/groupBy';
import routerStore from './routerStore';
import { getToken } from '../common/api';
import { PublishRecordOptions, publishVideoConfigs, videoConfig } from '../common/config';
import store from 'store';
import { matchPath } from "react-router";
import messageStore from './messageStore';

const match = matchPath<{ roomid: string }>(window.location.pathname, {
  path: "/room/:roomid",
  exact: true,
  strict: false
});

export class RoomStore {

  /** session.roomName */
  @observable
  public id: string = match && match.params.roomid || '';

  /** session.roomToken */
  @observable
  public token: string = '';

  /** appid */
  @observable
  public appId: string = RTC_APP_ID;

  /** 前后置摄像头 */
  @observable
  public faceingMode: string = 'user'

  /** 房间中的用户 */
  @observable.deep
  public users: Map<string, User> = new Map();

  /** 已选择要采集的 Track配置 */
  public selectTracks: (RecordConfig | undefined)[] = [];

  @observable
  public videoDeviceId?: string = undefined

  @observable
  public audioDeviceId?: string = undefined

  @observable
  public useAudio?: boolean = false

  @observable
  public handupStatus: boolean = false

  /** 已选择的清晰度 */
  @observable
  public selectVideoConfig: keyof publishVideoConfigs = '480p';

  /** 已发布的 Track */
  @observable.deep
  public publishedTracks: Map<string, Track> = new Map();

  /** 已发布的 AudioTrack */
  @computed
  public get publishedAudioTracks(): Track[] {
    return Array.from(this.publishedTracks.values())
      .filter(v => v.rtcTrack.info.kind === 'audio');
  }

  /** 已发布的 VideoTrack(Camera) */
  @computed
  public get publishedCameraTracks(): Track[] {
    return Array.from(this.publishedTracks.values())
      .filter(v => v.rtcTrack.info.tag === 'camera');
  }

  /** 已发布的 VideoTrack(Screen) */
  public get publishedScreenTracks(): Track[] {
    return Array.from(this.publishedTracks.values())
      .filter(v => v.rtcTrack.info.tag === 'screen');
  }

  /** 切换已发布的 VideoTrack(Camera) Mute状态 */
  @action.bound
  public toggleMutePublishedCamera() {
    const publishedCameraTracks = this.publishedCameraTracks;
    this.muteTracks(publishedCameraTracks.map(v => v.trackId), publishedCameraTracks.some(v => !v.muted));
  }
  /** 切换已发布的 VideoTrack(Screen) Mute状态 */
  @action.bound
  public toggleMutePublishedScreen() {
    const publishedScreenTracks = this.publishedScreenTracks;
    this.muteTracks(publishedScreenTracks.map(v => v.trackId), publishedScreenTracks.some(v => !v.muted));
  }
  /** 切换前后置摄像头 */
  @action.bound
  public async toggleCameraFacingMode() {
    this.setFaceingMode(this.faceingMode === 'user' ? 'environment' : 'user')
    await this.unpublish()
    const rtcTracks = await this.getSelectTracks('faceingMode')
    console.log("changeFaceingMode:", this.faceingMode);
    if(this.handupStatus === false) {
      await this.publish(rtcTracks);
    }
  }
  /** 切换已发布的 AudioTrack Mute状态 */
  @action.bound
  public toggleMutePublishedAudio() {
    const publishedAudioTracks = this.publishedAudioTracks;
    this.muteTracks(publishedAudioTracks.map(v => v.trackId), publishedAudioTracks.some(v => !v.muted));
  }

  @action.bound
  public updateUseAudio(audio: boolean) {
    this.useAudio = audio
  }

  /** 已订阅的 Track Map */
  @observable.deep
  public subscribedTracks: Map<string, Track> = new Map();

  /** session.roomState 同步更新 */
  @observable
  public state: RoomState = RoomState.Idle;

  /** 当前发布 Track 的实时状态，每隔 1 秒更新 */
  @observable
  public publishTracksReport: {
    audio: TrackStatsReport | null;
    video: TrackStatsReport | null;
    screen: TrackStatsReport | null;
  } = { audio: null, video: null, screen: null };


  /** TrackModeSession */
  public session: TrackModeSession = new TrackModeSession();

  /** 房间内已发布的 TrackBaseInfo */
  public publishedTrackInfos: Map<string, TrackBaseInfo> = new Map();

  /** 使用 deviceManager 采集的 sdk 中的 AudioTrack | Track 离开房间释放用 */
  public localTracks: (RTCTrack | AudioTrack)[] = [];

  private statusInterval?: number;

  constructor() {
    this.session.on('room-state-change', this.setState);
    this.session.on('user-join', this.addUser);
    this.session.on('user-leave', this.removeUser);
    this.session.on('track-add', this.addTracks);
    this.session.on('track-remove', this.removeTracks);
    this.session.on('mute-tracks', this.updateTracksMute);
    this.session.on("disconnect", this.handleDisconnect);
    this.session.on('remote-user-reconnecting', this.handleRemoteUserReconnecting);
    this.session.on('remote-user-reconnected', this.handleRemoteUserReconnected);
    this.selectTracks[1] = PublishRecordOptions[1].config;
    this.selectTracks[0] = PublishRecordOptions[0].config;
    const selectVideoConfig = store.get('selectVideoConfig') as keyof publishVideoConfigs;
    if (selectVideoConfig) {
      this.selectVideoConfig = selectVideoConfig;
    }
    const storeAppId = store.get("qnrtnAppID");
    if (storeAppId) {
      this.setAppId(storeAppId);
    }
    window.onbeforeunload = () => this.leaveRoom();
  }

  @action 
  setFaceingMode(type: string) {
    this.faceingMode = type
  }

  @action
  public setId(roomId: string) {
    this.id = roomId;
  }

  @action
  public setToken(token: string) {
    this.token = token;
  }

  @action
  setHandupStatus(type: boolean) {
    this.handupStatus = type
  }

  @action
  public async fetchRoomToken(): Promise<string> {
    const userid = userStore.id;
    if (!userid || !this.id) return '';

    const token: string = await getToken(this.appId, this.id, userid);
    runInAction(() => {
      this.token = token;
    })
    return token;
  }

  @action.bound
  public setAppId(appid: string, isStore?: boolean) {
    this.appId = appid;
    if (isStore) {
      store.set("qnrtnAppID", appid);
    }
  }

  @action.bound
  public setState(state: RoomState): void {
    console.log("room state change", state);
    this.state = state;
  }

  @action.bound
  public async setVideoDeviceId(deviceId: string) {
    this.videoDeviceId = deviceId
    await this.unpublish()
    // this.releaseLocalTracks()
    const rtcTracks = await this.getSelectTracks()
    console.log("update video deviceid repub:", rtcTracks);
    if(this.handupStatus === false) {
      await this.publish(rtcTracks);
    }
  }

  @action.bound
  public async setAudioDeviceId(deviceId: string) {
    this.audioDeviceId = deviceId
    await this.unpublish()
    // this.releaseLocalTracks()
    const rtcTracks = await this.getSelectTracks()
    console.log("update audio deviceid repub:", rtcTracks);
    if(this.handupStatus === false) {
      await this.publish(rtcTracks);
    }
  }

  @action.bound
  private addUser(user: RTCUser): void {
    if (this.users.has(user.userId)) return;
    this.users.set(user.userId, new User(user));
  }

  @action.bound
  private removeUser(user: RTCUser): void {
    this.users.delete(user.userId);
  }

  @action.bound
  private addTracks(tracks: TrackBaseInfo[]): void {
    const groupTracks = groupBy(tracks, 'userId');
    for (const userid of Object.keys(groupTracks)) {
      const tracks = groupTracks[userid];
      if (this.users.has(userid)) {
        const user = this.users.get(userid) as User;
        for (const track of tracks) {
          user.addPublishedTrackInfo(track);
          this.publishedTrackInfos.set(track.trackId as string, track);
        }
      }
    }
    this.subscribe(tracks.map(v => v.trackId) as string[]);
  }

  @action.bound
  private removeTracks(tracks: TrackBaseInfo[]): void {
    const groupTracks = groupBy(tracks, 'userId');
    for (const userid of Object.keys(groupTracks)) {
      const tracks = groupTracks[userid];
      if (this.users.has(userid)) {
        const user = this.users.get(userid) as User;
        for (const track of tracks) {
          const trackid = track.trackId;
          if (!trackid) return;
          user.tracks.delete(trackid)
          user.removePublishedTrackInfo(track);
          this.publishedTrackInfos.delete(trackid);
        }
      }
    }
  }


  @action.bound
  private updateTracksMute(tracks: any): void {
    for (const track of tracks) {
      const subTrack = this.subscribedTracks.get(track.trackId);
      if (subTrack) {
        console.log("set subTrack mute", subTrack, track.muted);
        subTrack.muted = track.muted;
        const user = this.users.get(subTrack.userId as string);
        if (user) {
          user.updateTrack(subTrack.trackId, subTrack);
        }
      }
    }
  }

  @action.bound
  private syncUserList(users: RTCUser[]): void {
    for (const userid of this.users.keys()) {
      if (!users.find((user) => user.userId === userid)) {
        this.users.delete(userid);
      }
    }
    for (const user of users) {
      if (!this.users.has(user.userId)) {
        this.users.set(user.userId, new User(user));
      }
      for (const track of user.publishedTrackInfo) {
        this.publishedTrackInfos.set(track.trackId as string, track);
      }
    }
  }

  @action
  public async joinRoom(token: string = this.token, userData?: string): Promise<void> {
    this.subscribedTracks.clear();
    this.publishedTrackInfos.clear();
    this.users.clear();
    if (!token) return;
    const users = await this.session.joinRoomWithToken(token, userData);
    this.setAppId(this.session.appId as string);
    userStore.setIdNoStore(this.session.userId as string);
    if (this.id !== this.session.roomName) {
      runInAction(() => {
        this.id = this.session.roomName as string;
      });
    }
    if (this.session.userId === 'admin') {
      this.session.setDefaultMergeStream(480, 848);
    }
    this.syncUserList(users);
  }

  @action
  public async publish(tracks: RTCTrack[] = []): Promise<void> {
    try {
      await this.session.publish(tracks);
      runInAction(() => {
        for (const track of tracks) {
          if (track.info.trackId) this.publishedTracks.set(track.info.trackId, new Track(track));
        }
      })
      if (this.statusInterval) {
        window.clearInterval(this.statusInterval);
      }
      this.statusInterval = window.setInterval(this.updateTrackStatusReport, 1000);
    } catch (e) {
      tracks.map(t => t.release());
      throw e;
    }
  }

  @action
  public muteTracks(trackids: string[], muted: boolean) {
    this.session.muteTracks(trackids.map(trackId => ({
      trackId,
      muted,
    })));
    for (const trackid of trackids) {
      const track = this.publishedTracks.get(trackid);
      if (!track) continue;
      track.updateTrack();
      this.publishedTracks.delete(trackid);
      this.publishedTracks.set(trackid, track);
    }
  }
  @action.bound
  public setSelectVideoConfig(config: keyof publishVideoConfigs) {
    this.selectVideoConfig = config;
    store.set('selectVideoConfig', config);
  }

  @action
  public async unpublish(): Promise<void> {
    const tracks: string[] = Array.from(this.publishedTracks.keys());
    await this.session.unpublish(tracks);
    this.publishedTracks.forEach(t => t.rtcTrack.release());
    this.publishedTracks.clear();
  }

  @action
  public async getSelectTracks(type = "deviceId"): Promise<RTCTrack[]> {

    const tracksConfig = this.selectTracks.filter(v => v) as RecordConfig[];
    // 只发布 camera screen audio 三路流。
    if (tracksConfig.length <= 3) {
      const config: RecordConfig = {};
      for (const c of tracksConfig) {
        Object.assign(config, c);
      }
      if (config.video) {
        Object.assign(config.video, (videoConfig.find(v => v.key === this.selectVideoConfig) || videoConfig[0]).config.video)
        if (this.videoDeviceId && type === 'deviceId') {
          Object.assign(config.video, { deviceId: this.videoDeviceId })
        }
        if(type === 'faceingMode') {
          delete config.video.deviceId
          Object.assign(config.video, { facingMode: this.faceingMode })
        }
      }
      if (config.audio) {
        if (this.audioDeviceId) {
          Object.assign(config.audio, { deviceId: this.audioDeviceId })
        }
      }

      if (this.useAudio) {
        if (config.audio) {
          delete config.audio
        }
        if (config.screen) {
          config.screen.audio = true
        }
      }
      console.log('tracks config:', config)

      return deviceManager.getLocalTracks(config)
        .then(async (tracks: RTCTrack[]) => {
          for (const track of tracks) {
            if (track.info.kind === "audio" && config.audio && config.audio.source) {
              track.setLoop(true);
              track.startAudioSource();
            }
            if (track.info.tag === 'camera') {
              track.setMaster(true);
            }
            if (track.info.kind === 'audio') {
              track.setMaster(true);
            }
            this.localTracks.push(track);
          }
          return tracks;
        });
    }
    // 这里是超过三路流的采集示例代码，demo里暂时不会触发
    let videoCount = 0;
    let audioCount = 0;
    return Promise.all(
      tracksConfig.map((config) => {
        if (config.video) {
          Object.assign(config.video, (videoConfig.find(v => v.key === this.selectVideoConfig) || videoConfig[0]).config.video)
        }
        // 每次只采集了一路流
        return deviceManager.getLocalTracks(config)
          .then(async ([track]: RTCTrack[]) => {
            if (config.audio && config.audio.source) {
              track.setLoop(true);
              track.startAudioSource();
            }
            // 只能发布 一个 video master 和 一个 audio master
            if (track.info.kind === 'video' && videoCount === 0) {
              track.setMaster(true);
              videoCount++;
            }
            if (track.info.kind === 'audio' && audioCount === 0) {
              track.setMaster(true);
              audioCount++;
            }
            this.localTracks.push(track);
            return track;
          });
      }));
  }

  /** 订阅 */
  @action
  public async subscribe(trackids: string[]): Promise<void> {
    let innerfunc;
    const removePromise = new Promise<RTCTrack[]>((resovle, reject) => {
      innerfunc = (tracks: TrackBaseInfo[]) => {
        for (const track of tracks) {
          if (trackids.includes((track.trackId as string))) {
            const error = new Error('订阅失败，订阅的track已移除');
            reject(error);
          }
        }
      }
      this.session.on('track-remove', innerfunc);
    });
    try {
      const rtctracks = await Promise.race([removePromise, this.session.subscribe(trackids)]);
      if (innerfunc) {
        this.session.off('track-remove', innerfunc);
      }
      runInAction(() => {
        for (const rtctrack of rtctracks) {
          const track = new Track(rtctrack);
          this.subscribedTracks.set(rtctrack.info.trackId as string, track);
          const user = this.users.get(rtctrack.userId as string);
          if (user) {
            user.tracks.set(rtctrack.info.trackId as string, track);
          }
        }
      });
    } catch (e) {
      console.warn(e);
      throw e;
    }
  }

  /** 订阅房间内所有 Track */
  @action
  public async subscribeAll(): Promise<void> {
    const trackids = Array.from(this.publishedTrackInfos.values())
      .map(v => v.trackId) as string[];
    console.log('trackids' + trackids);
    await this.subscribe(trackids);
  }


  /** 取消订阅 */
  @action
  public async unsubscribe(trackids: string[]): Promise<void> {
    await this.session.unsubscribe(trackids);
    runInAction(() => {
      for (const trackid of trackids) {
        const track = this.subscribedTracks.get(trackid);
        if (!track) { return; }
        this.subscribedTracks.delete(trackid);
        const user = this.users.get(track.userId as string);
        if (!user) { return; }
        user.tracks.delete(trackid);
      }
    });
  }

  @action
  releaseLocalTracks(): void {
    if (this.localTracks.length === 0) return;
    this.localTracks.forEach(t => t && t.release());
    this.localTracks = [];
  }

  /** 离开房间触发，释放所有房间内的 Track */
  @action
  public leaveRoom(): void {
    this.session.leaveRoom();
    this.publishedTracks.forEach(t => t.rtcTrack.release());
    this.publishedTracks.clear();
    this.subscribedTracks.clear();
    this.publishedTrackInfos.clear();
    this.users.clear();
    this.releaseLocalTracks();
    this.token = '';
    this.id = '';
    routerStore.push('/');
  }

  /** 每隔 1 秒获取当前发布 Track 的状态 */
  @action.bound
  private updateTrackStatusReport(): void {
    const publishedTracksList = Array.from(this.publishedTracks.values());
    const audioTrack = publishedTracksList.find(t => t.mediaTrack.kind === "audio");
    const videoTrack = publishedTracksList.find(t => t.tag === "camera");
    const screenTrack = publishedTracksList.find(t => t.tag === "screen");

    this.publishTracksReport.audio = null;
    if (audioTrack) {
      const audioTrackReportList = audioTrack.rtcTrack.getStats();
      if (audioTrackReportList.length > 0) {
        this.publishTracksReport.audio = audioTrackReportList[0];
      }
    }
    this.publishTracksReport.video = null;
    if (videoTrack) {
      const videoTrackReportList = videoTrack.rtcTrack.getStats();
      if (videoTrackReportList.length > 0) {
        this.publishTracksReport.video = videoTrackReportList[0];
      }
    }
    this.publishTracksReport.screen = null;
    if (screenTrack) {
      const screenTrackReportList = screenTrack.rtcTrack.getStats();
      if (screenTrackReportList.length > 0) {
        this.publishTracksReport.screen = screenTrackReportList[0];
      }
    }
  }

  /** 监听 session 的 disconnect 事件 */
  @action.bound
  private handleDisconnect(d: any): void {
    console.log('handleDiconnect', d);
    switch (d.code) {
      case 10006: {
        this.leaveRoom();
        messageStore.showAlert({
          show: true,
          title: '断开连接',
          content: '被管理员踢出房间',
        });
        return;
      }
      case 10004: {
        console.log("get 10004", this.publishedTracks, this.subscribedTracks);
        this.users.clear()
        this.joinRoom().then(() => {
          const rtcTracks = Array.from(this.publishedTracks.values()).map(t => t.rtcTrack);
          this.publishedTracks.clear();
          console.log("repub");
          return this.publish(rtcTracks);
        }).then(() => {
          return this.subscribeAll().catch(e => {
            console.log(e);
            messageStore.showAlert({
              show: true,
              title: '订阅失败',
              content: '自动订阅失败，请手动订阅',
            });
          });
        }).catch(e => {
          console.log(e);
          this.leaveRoom();
          messageStore.showAlert({
            show: true,
            title: '尝试重连失败',
            content: '与房间断开链接，请重新加入房间',
          });
        });
        return;
      }
      case 10011: {
        this.leaveRoom();
        messageStore.showAlert({
          show: true,
          title: '断开连接',
          content: '房间人数已满',
        });
        return;
      }
      case 10022: {
        this.leaveRoom();
        messageStore.showAlert({
          show: true,
          title: '断开连接',
          content: '该用户在其他页面或终端登录',
        });
        return;
      }
      case 10007: {
        this.leaveRoom();
        messageStore.showAlert({
          show: true,
          title: '断开连接',
          content: '网络异常断开，重连失败',
        });
        return;
      }
      default: {
        this.leaveRoom();
        return;
      }
    }
  }

  @action.bound
  private handleRemoteUserReconnecting(user: RTCUser): void {
    console.log('remote-user-reconnecting', user)
  }

  @action.bound
  private handleRemoteUserReconnected(user: RTCUser): void {
    console.log('remote-user-reconnected', user)
  }
}

export default new RoomStore();