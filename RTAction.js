// ==UserScript==
// @name         RTAction
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  A tool that can convert the audio from videos on web pages into real-time actions for serial port devices.
// @author       Karasukaigan
// @match        https://*.bilibili.com/video/*
// @match        https://live.bilibili.com/*
// @match        https://*.youtube.com/
// @match        https://*.youtube.com/shorts/*
// @match        https://*.youtube.com/watch*
// @match        https://*.tiktok.com/*
// @match        https://*.twitch.tv/*
// @include      https://*haven.com/video/*
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
    var rmsRising = false; // RMS值是否处在上升阶段
    var sawtoothSkew = 0.6; // 倾斜度，0为反向斜坡，0.5为三角波，1为正向斜坡
    var sawtoothPhase = 0; // 锯齿波相位
    var sawtoothAmplitude = 0; // 锯齿波振幅
    var sawtoothFrequency = 0.3; // 锯齿波频率
    var beatThreshold = 0.06; // 鼓点检测阈值，越低越敏感
    var rmsAmplification = 4; // RMS放大倍率
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
    const getBrowserLanguage = () => navigator.language?.split('-')[0] || 'en';
    let currentLang = 'zh';

    // 线性映射值到新的范围
    const mapValue = (value, min = 0, max = 1, newMin = 0, newMax = 9999) => {
        return ((Math.min(Math.max(value, min), max) - min) / (max - min)) * (newMax - newMin) + newMin;
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
        if (window.videoUpdateInterval) {
            clearInterval(window.videoUpdateInterval);
            window.videoUpdateInterval = null;
        }
        window.videoElement = null;
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
        title.style.cssText = 'font-size: 12px; font-weight: 600; color: #212529;';

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
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
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
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
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
                    console.error('Your browser does not support the Web Serial API');
                    testConnectionButton.disabled = true;
                    return;
                }
                const port = await navigator.serial.requestPort();
                window.selectedSerialPort = port;
                if (!window.selectedSerialPort.readable) {
                    await window.selectedSerialPort.open({ baudRate: 115200 });
                    console.log('Serial port connection established');
                }
                testConnectionButton.disabled = false;
                if (getVideoElementButton) getVideoElementButton.click();
            } catch (error) {
                if (error.name === 'NotFoundError') {
                    console.log('User cancelled the serial port selection');
                } else {
                    console.error('Requesting serial port permission failed:', error);
                    testConnectionButton.disabled = true;
                }
            }
        }

        async function testConnection() {
            if (!navigator.serial) return;
            if (!window.selectedSerialPort) return;
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
                console.log(`Sending message to serial port: ${message}`);
            } catch (error) {
                console.error('Test connection failed:', error);
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
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        `;
        getVideoElementButton = button;

        // 模式选择
        const waveformTypeDiv = document.createElement('div');
        waveformTypeDiv.style.cssText = `
            display: flex;
            gap: 5px;
            margin-bottom: 10px;
            padding: 8px;
            background: #f8f9fa;
            border-radius: 6px;
            color-scheme: light;
        `;

        const rmsRadio = document.createElement('input');
        rmsRadio.type = 'radio';
        rmsRadio.id = 'waveform-rms';
        rmsRadio.name = 'waveform-type';
        rmsRadio.value = 'rms';

        const rmsLabel = document.createElement('label');
        rmsLabel.htmlFor = 'waveform-rms';
        rmsLabel.textContent = 'RMS';
        rmsLabel.style.cssText = `color: #000; cuersor: pointer; margin-right: 10px; font-size: 12px;`;

        const sawtoothRadio = document.createElement('input');
        sawtoothRadio.type = 'radio';
        sawtoothRadio.id = 'waveform-sawtooth';
        sawtoothRadio.name = 'waveform-type';
        sawtoothRadio.value = 'sawtooth';
        sawtoothRadio.checked = true;

        const sawtoothLabel = document.createElement('label');
        sawtoothLabel.htmlFor = 'waveform-sawtooth';
        sawtoothLabel.textContent = 'Sawtooth';
        sawtoothLabel.style.cssText = `color: #000; cuersor: pointer; font-size: 12px;`;

        waveformTypeDiv.appendChild(rmsRadio);
        waveformTypeDiv.appendChild(rmsLabel);
        waveformTypeDiv.appendChild(sawtoothRadio);
        waveformTypeDiv.appendChild(sawtoothLabel);

        // RMS放大倍率滑块
        const amplificationDiv = document.createElement('div');
        amplificationDiv.style.cssText = `
            display: flex;
            align-items: center;
            margin-bottom: 10px;
            padding: 8px;
            background: #f8f9fa;
            border-radius: 6px;
        `;

        const amplificationSlider = document.createElement('input');
        amplificationSlider.type = 'range';
        amplificationSlider.id = 'rms-amplification-slider';
        amplificationSlider.min = '1';
        amplificationSlider.max = '10';
        amplificationSlider.step = '1';
        amplificationSlider.value = rmsAmplification;
        amplificationSlider.style.cssText = `
            flex: 1;
            margin-right: 8px;
            -webkit-appearance: none;
            height: 6px;
            border-radius: 3px;
            background: #dee2e6;
            outline: none;
        `;

        const amplificationValue = document.createElement('span');
        amplificationValue.textContent = `RMS×${rmsAmplification}`;
        amplificationValue.style.cssText = `
            font-size: 14px;
            color: #495057;
            font-weight: 500;
            min-width: 25px;
            text-align: center;
        `;

        amplificationSlider.addEventListener('input', () => {
            rmsAmplification = parseInt(amplificationSlider.value);
            amplificationValue.textContent = `RMS×${rmsAmplification}`;
        });

        amplificationDiv.appendChild(amplificationSlider);
        amplificationDiv.appendChild(amplificationValue);
        
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
        audioWaveformDiv.textContent = '';

        // 组装面板
        content.appendChild(refreshPortsButton);
        content.appendChild(testConnectionButton);
        content.appendChild(button);
        content.appendChild(waveformTypeDiv);
        content.appendChild(amplificationDiv);
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

        // 绘制波形
        function drawWaveform(canvas, ctx, audioAnalyser, historyData, maxFrames) {
            const bufferSize = audioAnalyser.frequencyBinCount; // 256个点
            
            // 获取当前帧的时域数据
            const currentData = new Uint8Array(bufferSize);
            audioAnalyser.getByteTimeDomainData(currentData);
            
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
            
            requestAnimationFrame(() => drawWaveform(canvas, ctx, audioAnalyser, historyData, maxFrames));
        }

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
                const selectors = {
                    'youtube': '.html5-video-container',
                    'live.bilibili': '.live-player-mounter',
                    'tiktok': '.xgplayer-container',
                    'twitch': '.video-player__container',
                    'haven': '.hls-player-content'
                };
                let videoWrapSelector = '.bpx-player-video-wrap';
                for (const [key, selector] of Object.entries(selectors)) {
                    if (domain.includes(key)) {
                        videoWrapSelector = selector;
                        break;
                    }
                }
                const videoWrap = document.querySelector(videoWrapSelector);
                const video = videoWrap.querySelector('video');
                if (!video) return;
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
                            
                            // 绘制波形
                            drawWaveform(canvas, ctx, analyser, historyData, maxFrames);
                        } catch (e) {
                            waveformDisplay.innerHTML = `<div style="text-align:center;color:#dc3545;">${e.message}</div>`;
                            console.error('Audio analysis error:', e);
                        }
                    }, 100);
                }

                window.videoUpdateInterval = setInterval(updateTimeDisplay, 50); // 50ms更新一次
                updateTimeDisplay(); // 初始更新
            } catch (e) {
                console.error('Failed to get video element:', e);
            }
        });

        // i18n
        langToggle.addEventListener('click', (event) => {
            event.stopPropagation();
            currentLang = currentLang === 'zh' ? 'en' : 'zh';
            updateLanguage();
        });
        if (getBrowserLanguage() !== 'zh') {
            langToggle.click();
        }
        function updateLanguage() {
            const texts = langTexts[currentLang];
            refreshPortsButton.textContent = texts.refreshPorts;
            testConnectionButton.textContent = texts.testConnection;
            button.textContent = texts.getVideoElement;
        }
    }

    // 更新时间显示
    const updateTimeDisplay = () => {
        videoMs = Math.round(window.videoElement.currentTime * 1000);
        if (!window.videoElement.paused) {
            calcPos();
            if (previousPos !== currentPos) sendPositionToSerial();
        }
    };

    // 创建面板
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createControlPanel);
    } else {
        createControlPanel();
    }

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
        let result = Math.min(rms * rmsAmplification, 1);
        result = findClosestValue(result);
        videoRms.shift();
        videoRms.push(result);

        let weightedSum = 0;
        let weightSum = 0;
        const len = videoRms.length;
        for (let i = 0; i < len; i++) {
            const weight = i + 1;
            weightedSum += videoRms[i] * weight;
            weightSum += weight;
        }
        const smoothedValue = weightedSum / weightSum;
        return smoothedValue;
    }

    // 计算锯齿波
    function calculateSawtooth(rmsValue, currentTime = Date.now()) {
        // 检测鼓点（RMS值是否显著增加）
        const rmsChange = rmsValue - previousRms;
        const thresholdForBeat = 0.2; // 鼓点检测阈值（累计变化量）
        
        if (rmsValue > previousRms) {
            // 上升阶段
            if (!rmsRising) {
                rmsRising = true;
                window.rmsAccumulatedIncrease = rmsChange;
            } else {
                window.rmsAccumulatedIncrease = (window.rmsAccumulatedIncrease || 0) + rmsChange;
            }
        } else {
            // 从上升转为下降，检查是否达到鼓点阈值
            if (rmsRising && window.rmsAccumulatedIncrease && window.rmsAccumulatedIncrease >= thresholdForBeat) {
                const now = currentTime;
                beatHistory.push(now);
                lastBeatTime = now;
                const twoSecondsAgo = now - 1500; // 1500ms区间
                beatHistory = beatHistory.filter(time => time > twoSecondsAgo);
                
                if (beatHistory.length > 1) {
                    const timeSpan = beatHistory[beatHistory.length - 1] - beatHistory[0];
                    if (timeSpan > 0) {
                        const beatFrequencyRaw = (beatHistory.length - 1) / (timeSpan / 1000); // 每秒鼓点数
                        const beatFrequency = calculateY(beatFrequencyRaw);
                        let calculatedFrequency = beatFrequency; // 锯齿波频率
                        calculatedFrequency = Math.max(0.1, Math.min(calculatedFrequency, 4));
                        sawtoothFrequency = calculatedFrequency;
                        sawtoothSkew = sawtoothFrequency > 2 ? 0.5 : 0.6;
                        // console.log(`[RMS ${rmsValue}] ${beatFrequencyRaw} -> ${beatFrequency} -> ${calculatedFrequency}`);
                    }
                } else if (beatHistory.length === 1) {
                    sawtoothFrequency = 0.3; // 只有一个鼓点，使用默认频率
                }
            }
            // 结束上升阶段
            rmsRising = false;
            window.rmsAccumulatedIncrease = 0; // 重置累积上升值
        }
    
        previousRms = rmsValue;
    
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
        if (sawtoothPhase >= 1) sawtoothPhase -= Math.floor(sawtoothPhase);
        
        // 计算锯齿波值
        let rawSawtoothValue;
        if (sawtoothPhase < sawtoothSkew && sawtoothSkew !== 0) {
            // 上升段
            rawSawtoothValue = sawtoothPhase / sawtoothSkew;
        } else if (sawtoothSkew !== 1) {
            // 下降段
            rawSawtoothValue = (1 - sawtoothPhase) / (1 - sawtoothSkew);
        } else {
            // 完全反向斜坡
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

    // 绘制RMS波形
    function drawRmsWaveform(ctx, canvas, historyData) {
        if (historyData.length > 1) {
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#0d6efd';
            ctx.beginPath();
            const sliceWidth = (canvas.width - 30) / (historyData.length - 1);
            for (let i = 0; i < historyData.length; i++) {
                const y = canvas.height - (historyData[i] * canvas.height);
                i === 0 ? ctx.moveTo(30, y) : ctx.lineTo(i * sliceWidth + 30, y);
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
                const y = canvas.height - ((historyData[i] + 1) * 0.5 * canvas.height);
                i === 0 ? ctx.moveTo(30, y) : ctx.lineTo(i * sliceWidth + 30, y);
            }
            ctx.stroke();
        }
    }

    // 发送命令到串口
    const sendPositionToSerial = async () => {
        if (!navigator.serial || !window.selectedSerialPort) return;
        try {
            if (!window.selectedSerialPort.readable) await window.selectedSerialPort.open({ baudRate: 115200 });
            const writer = window.selectedSerialPort.writable.getWriter();
            const tcodeCmd = `L0${currentPos}I50\n`;
            console.log('[tcode]', tcodeCmd);
            await writer.write(new TextEncoder().encode(tcodeCmd));
            writer.releaseLock();
        } catch (e) { console.error('Failed to send serial command:', e); }
    };

    const calculateY = x => x <= 4 ? x : (x >= 0 ? Math.pow(x-1, 1/4) : -Math.pow(1-x, 1/4));
})();