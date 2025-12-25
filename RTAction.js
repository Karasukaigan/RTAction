// ==UserScript==
// @name         RTAction
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  一个可以将网页端视频音频实时转化为串口设备动作的工具。A tool that can convert the audio from videos on web pages into real-time actions for serial port devices.
// @author       Karasukaigan
// @match        https://*.bilibili.com/video/*
// @match        https://*.youtube.com/shorts/*
// @match        https://*.youtube.com/watch*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const domain = window.location.hostname; // 域名
    let currentPos = 5000; // 当前位置
    let previousPos = 9999; // 上一个位置
    let getVideoElementButton = null;
    window.videoElement = null; // 主视频
    var videoMs = 0; // 当前毫秒数
    let currentTargets = []; // RMS值分段，实际已弃用
    var videoRms = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 最近10个RMS值
    var videoSawtooth = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 最近10个锯齿波值
    var previousRms = 0; // 上一次RMS值
    var sawtoothSkew = 0.6; // 倾斜度，0为反向斜坡，0.5为三角波，1为正向斜坡
    var sawtoothPhase = 0; // 锯齿波相位
    var sawtoothAmplitude = 0; // 锯齿波振幅
    var sawtoothFrequency = 0.3; // 锯齿波频率
    var beatThreshold = 0.055; // 鼓点检测阈值，越低越敏感
    var beatHistory = []; // 最近几秒的鼓点时间戳
    var lastBeatTime = 0; // 上一次检测到鼓点的时间
    
    const langTexts = {
        'zh': {
            refreshPorts: '选择串口',
            testConnection: '测试',
            getVideoElement: '获取视频元素',
        },
        'en': {
            refreshPorts: 'Select Serial Port',
            testConnection: 'Test',
            getVideoElement: 'Get Video Element',
        }
    };
    let currentLang = 'zh';

    // 线性映射值到新的范围
    const mapValue = (value, min = 0, max = 1, newMin = 0, newMax = 9999) => {
        const clampedValue = Math.min(Math.max(value, min), max);
        const mappedValue = ((clampedValue - min) / (max - min)) * (newMax - newMin) + newMin;
        return mappedValue;
    };

    // 计算位置
    const calcPos = () => {
        previousPos = currentPos;
        const isSawtoothMode = document.getElementById('waveform-sawtooth') && document.getElementById('waveform-sawtooth').checked;
        if (isSawtoothMode) {
            // 使用锯齿波值计算位置
            currentPos = Math.round(mapValue((videoSawtooth[videoSawtooth.length - 1] + 1) / 2));
        } else {
            // 使用RMS值计算位置
            currentPos = Math.round(mapValue(1 - videoRms[videoRms.length - 1]));
        }
        return currentPos;
    };
    
    // 清理，防止内存泄漏
    function cleanup() {
        // 清理定时器
        if (window.videoUpdateInterval) {
            clearInterval(window.videoUpdateInterval);
            window.videoUpdateInterval = null;
        }
        
        // 清除视频元素全局引用
        window.videoElement = null;
        
        // 移除事件监听器
        if (window.videoElement && window.videoTimeUpdateListener) {
            window.videoElement.removeEventListener('timeupdate', window.videoTimeUpdateListener);
        }
        if (window.videoElement && window.videoPlayListener) {
            window.videoElement.removeEventListener('play', window.videoPlayListener);
        }
        if (window.videoElement && window.videoPauseListener) {
            window.videoElement.removeEventListener('pause', window.videoPauseListener);
        }
    }

    window.addEventListener('beforeunload', cleanup);

    // 创建控制面板
    function createControlPanel() {
        const panel = document.createElement('div');
        panel.id = 'video-control-panel';
        panel.style.cssText = `
            position: fixed;
            bottom: 40px;
            right: 40px;
            width: 300px;
            background: #f8f9fa;
            border: 1px solid #dee2e6;
            border-radius: 12px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            z-index: 999999;
            transition: all 0.3s ease;
            overflow: hidden;
        `;

        // 标题栏
        const header = document.createElement('div');
        header.style.cssText = `
            padding: 12px 16px;
            background: #fff;
            border-bottom: 1px solid #dee2e6;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            user-select: none;
        `;

        const title = document.createElement('span');
        title.textContent = 'RTAction';
        title.style.cssText = 'font-weight: 600; color: #212529;';

        // 语言切换
        const langToggleContainer = document.createElement('div');
        langToggleContainer.style.cssText = `
            display: flex;
            gap: 5px;
        `;
        const langToggle = document.createElement('button');
        langToggle.textContent = '中/EN';
        langToggle.style.cssText = `
            background: none;
            border: 1px solid #0d6efd;
            color: #0d6efd;
            border-radius: 4px;
            padding: 2px 6px;
            font-size: 12px;
            cursor: pointer;
        `;
        langToggleContainer.appendChild(langToggle);

        header.appendChild(title);
        header.appendChild(langToggleContainer);

        // 内容区域
        const content = document.createElement('div');
        content.id = 'panel-content';
        content.style.cssText = `
            padding: 16px;
            background: #fff;
            transition: all 0.3s ease;
        `;

        // 串口设置
        const refreshPortsButton = document.createElement('button');
        refreshPortsButton.textContent = '选择串口';
        refreshPortsButton.style.cssText = `
            width: 63%;
            padding: 12px;
            background: #0d6efd;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            margin-bottom: 10px;
            float: left;
            margin-right: 4%;
        `;

        const testConnectionButton = document.createElement('button');
        testConnectionButton.textContent = '测试';
        testConnectionButton.style.cssText = `
            width: 33%;
            padding: 12px;
            background: #eef6ff;
            color: #0d6efd;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            margin-bottom: 10px;
            float: right;
        `;
        testConnectionButton.disabled = true;
        testConnectionButton.addEventListener('disabled', function() {
            if (this.disabled) {
                this.style.background = '#6c757d';
            } else {
                this.style.background = '#28a745';
            }
        });

        // 选择串口
        async function refreshSerialPorts() {
            try {
                if (!navigator.serial) {
                    alert('您的浏览器不支持Web Serial API');
                    testConnectionButton.disabled = true;
                    return;
                }
                
                // 请求用户选择串口设备
                const port = await navigator.serial.requestPort();
                
                // 保存端口引用到全局变量
                window.selectedSerialPort = port;
                
                // 自动打开串口连接
                if (!window.selectedSerialPort.readable) {
                    await window.selectedSerialPort.open({ baudRate: 115200 });
                    console.log('串口连接已建立');
                }
                
                // 启用测试按钮
                testConnectionButton.disabled = false;

                // 获取视频元素
                if (getVideoElementButton) {
                    getVideoElementButton.click();
                }
            } catch (error) {
                if (error.name === 'NotFoundError') {
                    console.log('用户取消了串口选择');
                } else {
                    console.error('请求串口权限失败:', error);
                    alert('串口连接失败: ' + error.message);
                    testConnectionButton.disabled = true;
                }
            }
        }

        async function testConnection() {
            if (!navigator.serial) {
                return;
            }
            if (!window.selectedSerialPort) {
                return;
            }
            try {
                if (!window.selectedSerialPort.readable) {
                    await window.selectedSerialPort.open({ baudRate: 115200 });
                }
                const randomValue = Math.floor(Math.random() * 10000);
                const message = `L0${randomValue}\n`;
                const writer = window.selectedSerialPort.writable.getWriter();
                const encoder = new TextEncoder();
                await writer.write(encoder.encode(message));
                writer.releaseLock();
                console.log(`发送消息到串口: ${message}`);
            } catch (error) {
                console.error('测试连接失败:', error);
            }
        }

        refreshPortsButton.addEventListener('click', refreshSerialPorts);
        testConnectionButton.addEventListener('click', testConnection);

        // 获取视频元素
        const button = document.createElement('button');
        button.textContent = '获取视频元素';
        button.style.cssText = `
            width: 100%;
            padding: 12px;
            background: #eef6ff;
            color: #0d6efd;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            margin-bottom: 10px;
        `;
        getVideoElementButton = button;

        // 模式选择
        const waveformTypeDiv = document.createElement('div');
        waveformTypeDiv.style.cssText = `
            display: flex;
            gap: 15px;
            margin-bottom: 10px;
            padding: 8px;
            background: #f8f9fa;
            border-radius: 6px;
        `;

        const rmsRadio = document.createElement('input');
        rmsRadio.type = 'radio';
        rmsRadio.id = 'waveform-rms';
        rmsRadio.name = 'waveform-type';
        rmsRadio.value = 'rms';

        const rmsLabel = document.createElement('label');
        rmsLabel.htmlFor = 'waveform-rms';
        rmsLabel.textContent = 'RMS';
        rmsLabel.style.cursor = 'pointer';

        const sawtoothRadio = document.createElement('input');
        sawtoothRadio.type = 'radio';
        sawtoothRadio.id = 'waveform-sawtooth';
        sawtoothRadio.name = 'waveform-type';
        sawtoothRadio.value = 'sawtooth';
        sawtoothRadio.checked = true; // 默认Sawtooth

        const sawtoothLabel = document.createElement('label');
        sawtoothLabel.htmlFor = 'waveform-sawtooth';
        sawtoothLabel.textContent = 'Sawtooth';
        sawtoothLabel.style.cursor = 'pointer';

        waveformTypeDiv.appendChild(rmsRadio);
        waveformTypeDiv.appendChild(rmsLabel);
        waveformTypeDiv.appendChild(sawtoothRadio);
        waveformTypeDiv.appendChild(sawtoothLabel);
        
        // 音频波形显示区域
        const audioWaveformDiv = document.createElement('div');
        audioWaveformDiv.id = 'audio-waveform-display';
        audioWaveformDiv.style.cssText = `
            height: 100px;
            background: #f8f9fa;
            border: 1px solid #e9ecef;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #6c757d;
            font-size: 14px;
        `;
        audioWaveformDiv.textContent = '等待获取视频元素...';

        // 组装面板
        content.appendChild(refreshPortsButton);
        content.appendChild(testConnectionButton);
        content.appendChild(button);
        content.appendChild(waveformTypeDiv);
        content.appendChild(audioWaveformDiv);

        panel.appendChild(header);
        panel.appendChild(content);

        document.body.appendChild(panel);

        // 折叠展开
        let isCollapsed = false;
        header.addEventListener('click', () => {
            isCollapsed = !isCollapsed;
            if (isCollapsed) {
                content.style.display = 'none';
                panel.style.width = '200px';
            } else {
                content.style.display = 'block';
                panel.style.width = '300px';
            }
        });

        button.addEventListener('click', () => {
            try {
                cleanup();

                // 重置锯齿波相关变量
                previousRms = 0;
                sawtoothPhase = 0;
                sawtoothAmplitude = 0;
                sawtoothFrequency = 0.3;
                videoSawtooth = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

                // 查找视频元素
                let videoWrapSelector = '.bpx-player-video-wrap';
                if (domain.includes("youtube")) {
                    videoWrapSelector = '.html5-video-container';
                }
                const videoWrap = document.querySelector(videoWrapSelector);
                const video = videoWrap.querySelector('video');
                if (!video) {
                    return;
                }
                window.videoElement = video; // 存储到全局变量

                // 显示音频波形区域
                const waveformDisplay = document.getElementById('audio-waveform-display');
                if (waveformDisplay) {
                    while (waveformDisplay.firstChild) {
                        waveformDisplay.removeChild(waveformDisplay.firstChild);
                    }
                    const canvas = document.createElement('canvas');
                    canvas.id = 'waveform-canvas';
                    canvas.width = 260;
                    canvas.height = 80;
                    canvas.style.width = '100%';
                    canvas.style.height = '100%';
                    waveformDisplay.appendChild(canvas);
                    
                    setTimeout(async () => {
                        try {
                            const canvas = document.getElementById('waveform-canvas');
                            const ctx = canvas.getContext('2d');
                            const AudioContext = window.AudioContext || window.webkitAudioContext;
                            
                            await new Promise(resolve => setTimeout(resolve, 50));
                            
                            // 复用或创建节点
                            let audioCtx;
                            if (window.audioContext) {
                                audioCtx = window.audioContext;
                            } else {
                                audioCtx = new AudioContext();
                                window.audioContext = audioCtx;
                            }
                            let source;
                            if (window.audioSource && window.audioSource.mediaElement === video) {
                                source = window.audioSource;
                            } else {
                                source = audioCtx.createMediaElementSource(video);
                                window.audioSource = source;
                            }
                            let analyser;
                            if (window.audioAnalyser) {
                                analyser = window.audioAnalyser;
                            } else {
                                analyser = audioCtx.createAnalyser();
                                window.audioAnalyser = analyser;
                            }
                            analyser.fftSize = 512;
                            
                            // 连接节点: source -> analyser -> destination
                            source.connect(analyser);
                            analyser.connect(audioCtx.destination);
                            
                            // 存储最近180帧的数据
                            const maxFrames = 180;
                            const historyData = [];
                            const bufferSize = analyser.frequencyBinCount; // 256个点
                            
                            // 绘制波形
                            function drawWaveform() {
                                // 获取当前帧的时域数据
                                const currentData = new Uint8Array(bufferSize);
                                analyser.getByteTimeDomainData(currentData);
                                
                                // 计算RMS值和锯齿波值
                                const rmsValue = calculateRMS(currentData);
                                const sawtoothValue = calculateSawtooth(rmsValue, Date.now());
                                
                                // 记录历史值
                                if (document.getElementById('waveform-sawtooth').checked) {
                                    historyData.push(sawtoothValue);
                                } else {
                                    historyData.push(rmsValue);
                                }
                                if (historyData.length > maxFrames) {
                                    historyData.shift();
                                }
                                
                                // 绘制
                                ctx.fillStyle = '#f8f9fa';
                                ctx.fillRect(0, 0, canvas.width, canvas.height);
                                ctx.fillStyle = '#6c757d';
                                ctx.font = '10px Arial';
                                ctx.textAlign = 'right';
                                if (document.getElementById('waveform-sawtooth').checked) {
                                    ctx.fillText('9999', 25, 10);
                                    ctx.fillText('5000', 25, canvas.height/2);
                                    ctx.fillText('0', 25, canvas.height - 2);
                                } else {
                                    ctx.fillText('0', 25, 10);
                                    ctx.fillText('5000', 25, canvas.height/2);
                                    ctx.fillText('9999', 25, canvas.height - 2);
                                }    
                                if (document.getElementById('waveform-sawtooth').checked) {
                                    // 绘制锯齿波
                                    drawSawtoothWaveform(ctx, canvas, historyData);
                                } else {
                                    // 绘制RMS波形
                                    drawRmsWaveform(ctx, canvas, historyData);
                                }
                                ctx.lineWidth = 1;
                                ctx.strokeStyle = '#adb5bd';
                                ctx.beginPath();
                                ctx.moveTo(30, canvas.height / 2);
                                ctx.lineTo(canvas.width, canvas.height / 2);
                                ctx.stroke();
                                
                                requestAnimationFrame(drawWaveform);
                            }

                            // 绘制RMS波形
                            function drawRmsWaveform(ctx, canvas, historyData) {
                                if (historyData.length > 1) {
                                    ctx.lineWidth = 2;
                                    ctx.strokeStyle = '#0d6efd';
                                    ctx.beginPath();
                                    const sliceWidth = (canvas.width - 30) / (historyData.length - 1);
                                    for (let i = 0; i < historyData.length; i++) {
                                        const y = canvas.height - (historyData[i] * canvas.height);
                                        if (i === 0) {
                                            ctx.moveTo(30, y);
                                        } else {
                                            ctx.lineTo(i * sliceWidth + 30, y);
                                        }
                                    }
                                    ctx.stroke();
                                }
                            }

                            // 绘制锯齿波
                            function drawSawtoothWaveform(ctx, canvas, historyData) {
                                if (historyData.length > 1) {
                                    ctx.lineWidth = 2;
                                    ctx.strokeStyle = '#28a745';
                                    ctx.beginPath();
                                    
                                    const sliceWidth = (canvas.width - 30) / (historyData.length - 1);
                                    
                                    for (let i = 0; i < historyData.length; i++) {
                                        const rawSawtoothValue = historyData[i];
                                        const y = canvas.height - ((rawSawtoothValue + 1) * 0.5 * canvas.height);
                                        if (i === 0) {
                                            ctx.moveTo(30, y);
                                        } else {
                                            ctx.lineTo(i * sliceWidth + 30, y);
                                        }
                                    }
                                    
                                    ctx.stroke();
                                }
                            }
                            
                            drawWaveform();
                        } catch (e) {
                            waveformDisplay.innerHTML = `<div style="text-align:center;color:#dc3545;">音频分析失败: ${e.message}</div>`;
                            console.error('音频分析错误:', e);
                        }
                    }, 100);
                }

                // 更新时间显示
                const updateTimeDisplay = () => {
                    videoMs = Math.round(video.currentTime * 1000);
                    if (!video.paused) {
                        calcPos();
                        if (previousPos !== currentPos) {
                            sendPositionToSerial();
                        }
                    }
                };

                // 清除之前的监听器和定时器
                if (window.videoTimeUpdateListener) {
                    video.removeEventListener('timeupdate', window.videoTimeUpdateListener);
                }
                if (window.videoPlayListener) {
                    video.removeEventListener('play', window.videoPlayListener);
                }
                if (window.videoPauseListener) {
                    video.removeEventListener('pause', window.videoPauseListener);
                }
                if (window.videoUpdateInterval) {
                    clearInterval(window.videoUpdateInterval);
                }

                // 50ms更新一次
                window.videoUpdateInterval = setInterval(updateTimeDisplay, 50);

                updateTimeDisplay(); // 初始更新
            } catch (error) {
                console.error('获取视频元素失败:', error);
            }
        });

        // i18n
        langToggle.addEventListener('click', (event) => {
            event.stopPropagation();
            currentLang = currentLang === 'zh' ? 'en' : 'zh';
            updateLanguage();
        });

        function updateLanguage() {
            const texts = langTexts[currentLang];
            refreshPortsButton.textContent = texts.refreshPorts;
            testConnectionButton.textContent = texts.testConnection;
            button.textContent = texts.getVideoElement;
        }
    }

    // 创建面板
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createControlPanel);
    } else {
        createControlPanel();
    }

    const style = document.createElement('style');
    style.textContent = `
        #video-control-panel button:active {
            transform: scale(0.98);
        }

        #video-control-panel button:focus {
            outline: 2px solid #0d6efd;
            outline-offset: 2px;
        }

        /* 响应式调整 */
        @media (max-width: 768px) {
            #video-control-panel {
                width: 280px !important;
                right: 10px !important;
                bottom: 70px !important;
            }

            #video-control-panel.collapsed {
                width: 180px !important;
            }
        }
    `;
    document.head.appendChild(style);

    const findClosestValue = (value) => {
        if (currentTargets.length === 0) {
            return Math.max(0, Math.min(1, value));
        }
        const clampedValue = Math.max(0, Math.min(1, value));
        return currentTargets.reduce((closest, current) => {
            return Math.abs(current - clampedValue) < Math.abs(closest - clampedValue) 
                ? current 
                : closest;
        });
    };

    // 计算RMS值
    function calculateRMS(data) {
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            const normalized = (data[i] - 128) / 128; // -1~1
            sum += normalized * normalized;
        }
        let rms = Math.sqrt(sum / data.length);
        let result = Math.min(rms * 4, 1); // 放大4倍，但不超过1
        result = findClosestValue(result);
        videoRms.shift();
        videoRms.push(result);
        const smoothedValue = videoRms.reduce((sum, val) => sum + val, 0) / videoRms.length; // 滑动平均
        return smoothedValue;
    }

    // 计算锯齿波
    function calculateSawtooth(rmsValue, currentTime = Date.now()) {
        // 检测鼓点（RMS值是否显著增加）
        const rmsChange = rmsValue - previousRms;
        const isBeat = rmsChange > beatThreshold;

        previousRms = rmsValue;

        // 检测到鼓点
        if (isBeat) {
            const now = currentTime;
            beatHistory.push(now);
            lastBeatTime = now;
            const twoSecondsAgo = now - 2000; // 2000ms区间
            beatHistory = beatHistory.filter(time => time > twoSecondsAgo);
            if (beatHistory.length > 1) {
                const timeSpan = beatHistory[beatHistory.length - 1] - beatHistory[0];
                if (timeSpan > 0) {
                    const beatFrequencyRaw = (beatHistory.length - 1) / (timeSpan / 1000); // 每秒鼓点数
                    const beatFrequency = calculateY(beatFrequencyRaw);
                    let calculatedFrequency = beatFrequency; // 锯齿波频率
                    calculatedFrequency = Math.max(0.1, Math.min(calculatedFrequency, 4));
                    sawtoothFrequency = calculatedFrequency;
                    console.log(`[RMS ${rmsValue}] ${beatFrequencyRaw} -> ${beatFrequency} -> ${calculatedFrequency}`);
                }
            } else if (beatHistory.length === 1) {
                sawtoothFrequency = 0.3; // 只有一个鼓点，使用默认频率
            }
        }
        
        sawtoothAmplitude = Math.min(rmsValue * 2, 1); // 根据RMS值更新振幅
        
        // 计算相位增量
        if (window.lastSawtoothTime) {
            const actualDeltaTime = (currentTime - window.lastSawtoothTime) / 1000; // 转换为秒
            sawtoothPhase += sawtoothFrequency * actualDeltaTime;
        } else {
            // 初始时使用固定时间增量
            const deltaTime = 1/30; // 30fps
            sawtoothPhase += sawtoothFrequency * deltaTime;
        }
        
        window.lastSawtoothTime = currentTime;
        
        // 确保相位在0到1之间
        if (sawtoothPhase >= 1) {
            sawtoothPhase -= Math.floor(sawtoothPhase);
        }
        
        // 计算锯齿波值
        let rawSawtoothValue;
        if (sawtoothPhase < sawtoothSkew && sawtoothSkew !== 0) {
            // 上升段
            rawSawtoothValue = sawtoothPhase / sawtoothSkew;
        } else if (sawtoothSkew !== 1) {
            // 下降段
            rawSawtoothValue = (1 - sawtoothPhase) / (1 - sawtoothSkew);
        } else {
            // 特殊情况：完全反向斜坡
            rawSawtoothValue = 1 - sawtoothPhase;
        }
        
        let normalizedSawtoothValue = rawSawtoothValue * 2 - 1; // 映射至-1到1
        let sawtoothValue = normalizedSawtoothValue * sawtoothAmplitude; // 应用振幅
        videoSawtooth.shift();
        videoSawtooth.push(sawtoothValue);
        
        // 计算滑动平均
        const smoothedValue = videoSawtooth.reduce((sum, val) => sum + val, 0) / videoSawtooth.length;
        
        return smoothedValue;
    }

    // 发送位置信息到串口
    const sendPositionToSerial = async () => {
        if (!navigator.serial || !window.selectedSerialPort) {
            return;
        }
        try {
            if (!window.selectedSerialPort.readable) {
                await window.selectedSerialPort.open({ baudRate: 115200 });
            }
            const message = `L0${currentPos}I50\n`;
            const writer = window.selectedSerialPort.writable.getWriter();
            const encoder = new TextEncoder();
            await writer.write(encoder.encode(message));
            writer.releaseLock();
        } catch (error) {
            console.error('发送位置信息失败:', error);
        }
    };

    const calculateY = (x) => {
        if (x <= 4) {
          return x;
        } else {
          const cubeRoot = x >= 0 ? Math.pow(x-1, 1/4) : -Math.pow(1-x, 1/4);
          return cubeRoot;
        }
    };
})();