// ==UserScript==
// @name         RTAction
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  A tool that can convert the audio from videos on web pages into real-time actions for serial port devices.
// @author       Karasukaigan
// @match        https://*.bilibili.com/video/*
// @match        https://live.bilibili.com/*
// @match        https://*.youtube.com/
// @match        https://*.youtube.com/shorts/*
// @match        https://*.youtube.com/watch*
// @match        https://*.tiktok.com/*
// @match        https://*.twitch.tv/*
// @match        https://*.nicovideo.jp/watch/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    const ZERO_HISTORY = Object.freeze(Array(10).fill(0));

    const domain = window.location.hostname; // Domain name
    let currentPos = 5000; // Current position
    let previousPos = 9999; // Previous position
    let getVideoElementButton = null;
    window.videoElement = null; // Main video
    let currentTargets = []; // RMS value segments, actually deprecated
    var videoRms = [...ZERO_HISTORY]; // Last 10 RMS values
    var videoSawtooth = [...ZERO_HISTORY]; // Last 10 sawtooth wave values
    var previousRms = 0; // Previous RMS value
    var sawtoothSkew = 0.4; // Skewness, 0 for reverse ramp, 0.5 for triangle wave, 1 for forward ramp
    var sawtoothPhase = 0; // Sawtooth wave phase
    var sawtoothAmplitude = 0; // Sawtooth wave amplitude
    var sawtoothFrequency = 0.3; // Sawtooth wave frequency
    var rmsAmplification = 4; // RMS amplification factor
    var lastFrequencyData = null; // Previous frequency-domain frame
    var onsetEnvelopeHistory = []; // Onset envelope history for tempo autocorrelation
    var onsetTimeHistory = []; // Timestamps for onset envelope
    var onsetBaseline = 0; // Slow baseline of onset score
    var smoothedBpm = 0; // Continuously estimated BPM
    var bpmConfidence = 0; // Confidence for BPM estimate
    var lastTempoLogTime = 0; // Debug log throttle timestamp
    
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

    // Linearly map value to new range
    const mapValue = (value, min = 0, max = 1, newMin = 0, newMax = 9999) => {
        return ((Math.min(Math.max(value, min), max) - min) / (max - min)) * (newMax - newMin) + newMin;
    };
    const isSawtoothMode = () => Boolean(document.getElementById('waveform-sawtooth')?.checked);
    const getVideoWrapperSelector = () => {
        const selectors = {
            'youtube': '.html5-video-container',
            'live.bilibili': '.live-player-mounter',
            'tiktok': '.xgplayer-container',
            'twitch': '.video-player__container',
            'nicovideo': '.PlayerPresenter'
        };
        for (const [key, selector] of Object.entries(selectors)) {
            if (domain.includes(key)) return selector;
        }
        return '.bpx-player-video-wrap';
    };

    // Calculate position
    const calcPos = () => {
        previousPos = currentPos;
        if (isSawtoothMode()) {
            // Use sawtooth wave value to calculate position
            currentPos = Math.round(mapValue((videoSawtooth[videoSawtooth.length - 1] + 1) / 2));
        } else {
            // Use RMS value to calculate position
            currentPos = Math.round(mapValue(1 - videoRms[videoRms.length - 1]));
        }
        return currentPos;
    };
    
    // Cleanup to prevent memory leaks
    function cleanup() {
        if (window.videoUpdateInterval) {
            clearInterval(window.videoUpdateInterval);
            window.videoUpdateInterval = null;
        }
        window.videoElement = null;
    }
    window.addEventListener('beforeunload', cleanup);

    // Create control panel
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

        // Title bar
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

        // Language toggle
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

        // Content area
        const content = document.createElement('div');
        content.id = 'panel-content';
        content.style.cssText = `
            padding: 16px;
            background: #fff;
            transition: all 0.3s ease;
        `;

        // Serial port settings
        const refreshPortsButton = document.createElement('button');
        refreshPortsButton.textContent = '选择串口';
        refreshPortsButton.style.cssText = `
            width: 63%;
            padding: 12px;
            background: #0d6efd;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 14px !important;
            font-weight: 500 !important;
            cursor: pointer;
            margin-bottom: 10px;
            float: left;
            margin-right: 4%;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
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
            font-size: 14px !important;
            font-weight: 500 !important;
            cursor: pointer;
            margin-bottom: 10px;
            float: right;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
        `;
        testConnectionButton.disabled = true;
        testConnectionButton.addEventListener('disabled', function() {
            if (this.disabled) {
                this.style.background = '#6c757d';
            } else {
                this.style.background = '#28a745';
            }
        });

        // Select serial port
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

        // Get video element
        const button = document.createElement('button');
        button.textContent = '获取视频元素';
        button.style.cssText = `
            width: 100%;
            padding: 12px;
            background: #eef6ff;
            color: #0d6efd;
            border: none;
            border-radius: 8px;
            font-size: 14px !important;
            font-weight: 500 !important;
            cursor: pointer;
            margin-bottom: 10px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
        `;
        getVideoElementButton = button;

        // Mode selection
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
        rmsLabel.style.cssText = `color: #000; cursor: pointer; margin-right: 10px; font-size: 12px;`;

        const sawtoothRadio = document.createElement('input');
        sawtoothRadio.type = 'radio';
        sawtoothRadio.id = 'waveform-sawtooth';
        sawtoothRadio.name = 'waveform-type';
        sawtoothRadio.value = 'sawtooth';
        sawtoothRadio.checked = true;

        const sawtoothLabel = document.createElement('label');
        sawtoothLabel.htmlFor = 'waveform-sawtooth';
        sawtoothLabel.textContent = 'Sawtooth';
        sawtoothLabel.style.cssText = `color: #000; cursor: pointer; font-size: 12px;`;

        waveformTypeDiv.appendChild(rmsRadio);
        waveformTypeDiv.appendChild(rmsLabel);
        waveformTypeDiv.appendChild(sawtoothRadio);
        waveformTypeDiv.appendChild(sawtoothLabel);

        // RMS amplification slider
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
        
        // Audio waveform display area
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

        // Assemble panel
        content.appendChild(refreshPortsButton);
        content.appendChild(testConnectionButton);
        content.appendChild(button);
        content.appendChild(waveformTypeDiv);
        content.appendChild(amplificationDiv);
        content.appendChild(audioWaveformDiv);

        panel.appendChild(header);
        panel.appendChild(content);

        document.body.appendChild(panel);

        // Collapse/expand
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

        // Draw waveform
        function drawWaveform(canvas, ctx, audioAnalyser, historyData, maxFrames) {
            const bufferSize = audioAnalyser.frequencyBinCount; // 256 points
            
            // Get current frame's time domain data
            const currentData = new Uint8Array(bufferSize);
            audioAnalyser.getByteTimeDomainData(currentData);
            const frequencyData = new Uint8Array(bufferSize);
            audioAnalyser.getByteFrequencyData(frequencyData);
            
            // Calculate RMS value and audio features
            const rmsValue = calculateRMS(currentData);
            const audioFeatures = extractAudioFeatures(currentData, frequencyData, rmsValue);
            const sawtoothValue = calculateSawtooth(rmsValue, audioFeatures, Date.now());
            
            // Record historical values
            if (isSawtoothMode()) {
                // Keep visualization in sync with currentPos source (videoSawtooth latest sample)
                historyData.push(videoSawtooth[videoSawtooth.length - 1] ?? sawtoothValue);
            } else {
                historyData.push(rmsValue);
            }
            if (historyData.length > maxFrames) {
                historyData.shift();
            }
            
            // Draw
            ctx.fillStyle = '#f8f9fa';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#6c757d';
            ctx.font = '10px Arial';
            ctx.textAlign = 'right';
            if (isSawtoothMode()) {
                ctx.fillText('9999', 25, 10);
                ctx.fillText('5000', 25, canvas.height/2);
                ctx.fillText('0', 25, canvas.height - 2);
            } else {
                ctx.fillText('0', 25, 10);
                ctx.fillText('5000', 25, canvas.height/2);
                ctx.fillText('9999', 25, canvas.height - 2);
            }    
            if (isSawtoothMode()) {
                // Draw sawtooth waveform
                drawWaveformLine(ctx, canvas, historyData, '#28a745', value => (value + 1) * 0.5);
            } else {
                // Draw RMS waveform
                drawWaveformLine(ctx, canvas, historyData, '#0d6efd');
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

                // Reset sawtooth wave related variables
                previousRms = 0;
                sawtoothPhase = 0;
                sawtoothAmplitude = 0;
                sawtoothFrequency = 0.3;
                videoSawtooth = [...ZERO_HISTORY];
                lastFrequencyData = null;
                onsetEnvelopeHistory = [];
                onsetTimeHistory = [];
                onsetBaseline = 0;
                smoothedBpm = 0;
                bpmConfidence = 0;
                lastTempoLogTime = 0;
                window.lastSawtoothTime = null;

                // Find video element
                const videoWrap = document.querySelector(getVideoWrapperSelector());
                if (!videoWrap) return;
                const video = videoWrap.querySelector('video');
                if (!video) return;
                window.videoElement = video; // Store to global variable

                // Display audio waveform area
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
                            
                            // Reuse or create nodes
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
                            
                            // Connect nodes: source -> analyser -> destination
                            source.connect(analyser);
                            analyser.connect(audioCtx.destination);
                            
                            // Store last 180 frames of data
                            const maxFrames = 180;
                            const historyData = [];
                            
                            // Draw waveform
                            drawWaveform(canvas, ctx, analyser, historyData, maxFrames);
                        } catch (e) {
                            waveformDisplay.innerHTML = `<div style="text-align:center;color:#dc3545;">${e.message}</div>`;
                            console.error('Audio analysis error:', e);
                        }
                    }, 100);
                }

                window.videoUpdateInterval = setInterval(updateTimeDisplay, 50); // Update every 50ms
                updateTimeDisplay(); // Initial update
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

    // Update time display
    const updateTimeDisplay = () => {
        if (!window.videoElement.paused) {
            calcPos();
            if (previousPos !== currentPos) sendPositionToSerial();
        }
    };

    // Create panel
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

    // Calculate RMS value
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

    // Extract rhythm features from original audio signal
    function extractAudioFeatures(timeData, frequencyData, rmsValue) {
        let lowBandSum = 0;
        let totalBandSum = 0;
        const lowBandEnd = Math.max(4, Math.floor(frequencyData.length * 0.12));
        for (let i = 0; i < frequencyData.length; i++) {
            totalBandSum += frequencyData[i];
            if (i < lowBandEnd) lowBandSum += frequencyData[i];
        }
        const lowBandEnergy = lowBandEnd > 0 ? (lowBandSum / lowBandEnd) / 255 : 0;
        const lowBandRatio = totalBandSum > 0 ? lowBandSum / totalBandSum : 0;

        let spectralFlux = 0;
        if (lastFrequencyData && lastFrequencyData.length === frequencyData.length) {
            for (let i = 0; i < frequencyData.length; i++) {
                const diff = frequencyData[i] - lastFrequencyData[i];
                if (diff > 0) spectralFlux += diff;
            }
            spectralFlux /= frequencyData.length * 255;
        }
        lastFrequencyData = frequencyData.slice();

        let zeroCrossings = 0;
        for (let i = 1; i < timeData.length; i++) {
            const prev = timeData[i - 1] - 128;
            const curr = timeData[i] - 128;
            if ((prev >= 0 && curr < 0) || (prev < 0 && curr >= 0)) zeroCrossings++;
        }
        const zcr = timeData.length > 1 ? zeroCrossings / (timeData.length - 1) : 0;
        const rmsRise = Math.max(0, rmsValue - previousRms);

        // Onset score: partially rely on raw audio spectral change, then combine with RMS rise
        const onsetScore = Math.max(0, Math.min(1,
            (spectralFlux * 0.5) +
            (lowBandEnergy * 0.2) +
            (lowBandRatio * 0.2) +
            (rmsRise * 1.4) -
            (Math.abs(zcr - 0.12) * 0.08)
        ));

        return { lowBandEnergy, lowBandRatio, spectralFlux, zcr, onsetScore };
    }

    function pushOnsetSample(onsetScore, currentTime) {
        onsetBaseline = onsetBaseline * 0.92 + onsetScore * 0.08;
        const pulse = Math.max(0, onsetScore - onsetBaseline * 0.92);
        onsetEnvelopeHistory.push(pulse);
        onsetTimeHistory.push(currentTime);

        const keepMs = 9000;
        while (onsetTimeHistory.length > 0 && onsetTimeHistory[0] < currentTime - keepMs) {
            onsetTimeHistory.shift();
            onsetEnvelopeHistory.shift();
        }
    }

    function estimateTempoFromHistory() {
        const n = onsetEnvelopeHistory.length;
        if (n < 120 || onsetTimeHistory.length !== n) return { bpm: 0, confidence: 0 };

        const spanMs = onsetTimeHistory[n - 1] - onsetTimeHistory[0];
        if (spanMs < 2800) return { bpm: 0, confidence: 0 };
        const avgDt = (spanMs / (n - 1)) / 1000;
        if (!Number.isFinite(avgDt) || avgDt <= 0) return { bpm: 0, confidence: 0 };

        const minBpm = 65;
        const maxBpm = 190;
        const minLag = Math.max(2, Math.floor((60 / maxBpm) / avgDt));
        const maxLag = Math.min(n - 2, Math.ceil((60 / minBpm) / avgDt));
        if (maxLag <= minLag) return { bpm: 0, confidence: 0 };

        let mean = 0;
        for (let i = 0; i < n; i++) mean += onsetEnvelopeHistory[i];
        mean /= n;

        const normalized = new Array(n);
        let energy = 0;
        for (let i = 0; i < n; i++) {
            const v = Math.max(0, onsetEnvelopeHistory[i] - mean * 0.6);
            normalized[i] = v;
            energy += v * v;
        }
        if (energy < 1e-7) return { bpm: 0, confidence: 0 };

        const corrCache = new Map();
        const corrAt = (lag) => {
            if (corrCache.has(lag)) return corrCache.get(lag);
            let cross = 0;
            let normA = 0;
            let normB = 0;
            for (let i = lag; i < n; i++) {
                const a = normalized[i];
                const b = normalized[i - lag];
                cross += a * b;
                normA += a * a;
                normB += b * b;
            }
            const value = (normA > 0 && normB > 0) ? (cross / Math.sqrt(normA * normB)) : 0;
            corrCache.set(lag, value);
            return value;
        };

        let bestLag = 0;
        let bestScore = 0;
        for (let lag = minLag; lag <= maxLag; lag++) {
            const base = corrAt(lag);
            const halfLag = Math.round(lag / 2);
            const doubleLag = lag * 2;
            const half = halfLag >= minLag ? corrAt(halfLag) : 0;
            const dbl = doubleLag <= maxLag ? corrAt(doubleLag) : 0;
            const score = base + dbl * 0.35 + half * 0.2;
            if (score > bestScore) {
                bestScore = score;
                bestLag = lag;
            }
        }
        if (!bestLag) return { bpm: 0, confidence: 0 };

        let bpm = 60 / (bestLag * avgDt);
        while (bpm < minBpm) bpm *= 2;
        while (bpm > maxBpm) bpm /= 2;
        const confidence = Math.max(0, Math.min(1, (bestScore - 0.1) / 0.45));
        return { bpm, confidence };
    }

    function updateTempoFromAudio(audioFeatures, currentTime) {
        const onsetScore = audioFeatures?.onsetScore ?? 0;
        pushOnsetSample(onsetScore, currentTime);

        const { bpm, confidence } = estimateTempoFromHistory();
        if (bpm > 0) {
            if (smoothedBpm <= 0) smoothedBpm = bpm;
            const alpha = confidence > 0.55 ? 0.24 : 0.1;
            smoothedBpm = smoothedBpm * (1 - alpha) + bpm * alpha;
            bpmConfidence = bpmConfidence * 0.85 + confidence * 0.15;
        } else {
            bpmConfidence *= 0.98;
        }

        const beatFrequencyRaw = smoothedBpm > 0 ? smoothedBpm / 60 : 0;
        const mappedFrequency = Math.round(calculateY(beatFrequencyRaw) * 100) / 100;
        sawtoothFrequency = Math.max(0.1, Math.min(mappedFrequency, 4));
        console.log(`[${currentPos}] [${bpm}] ${beatFrequencyRaw} -> ${mappedFrequency} -> ${sawtoothFrequency}`);

        if (window.RTActionTempoDebug && currentTime - lastTempoLogTime > 500) {
            console.log(`[tempo] bpm=${smoothedBpm.toFixed(1)} conf=${bpmConfidence.toFixed(2)} rawHz=${beatFrequencyRaw.toFixed(2)} targetHz=${targetFrequency.toFixed(2)}`);
            lastTempoLogTime = currentTime;
        }
    }

    // Calculate sawtooth wave
    function calculateSawtooth(rmsValue, audioFeatures, currentTime = Date.now()) {
        updateTempoFromAudio(audioFeatures, currentTime);
        sawtoothSkew = sawtoothFrequency > 2 ? 0.5 : 0.6;
    
        previousRms = rmsValue;
    
        sawtoothAmplitude = Math.min(rmsValue * 2, 1); // Update amplitude based on RMS value
        
        // Calculate phase increment
        if (window.lastSawtoothTime) {
            const actualDeltaTime = (currentTime - window.lastSawtoothTime) / 1000; // Convert to seconds
            sawtoothPhase += sawtoothFrequency * actualDeltaTime;
        } else {
            // Initially use fixed time increment
            const deltaTime = 1/30; // 30fps
            sawtoothPhase += sawtoothFrequency * deltaTime;
        }
        window.lastSawtoothTime = currentTime;
        if (sawtoothPhase >= 1) sawtoothPhase -= Math.floor(sawtoothPhase);
        
        // Calculate sawtooth wave value
        let rawSawtoothValue;
        if (sawtoothPhase < sawtoothSkew && sawtoothSkew !== 0) {
            // Rising segment
            rawSawtoothValue = sawtoothPhase / sawtoothSkew;
        } else if (sawtoothSkew !== 1) {
            // Falling segment
            rawSawtoothValue = (1 - sawtoothPhase) / (1 - sawtoothSkew);
        } else {
            // Completely reverse ramp
            rawSawtoothValue = 1 - sawtoothPhase;
        }
        
        let normalizedSawtoothValue = rawSawtoothValue * 2 - 1; // Map to -1 to 1
        let sawtoothValue = normalizedSawtoothValue * sawtoothAmplitude; // Apply amplitude
        videoSawtooth.shift();
        videoSawtooth.push(sawtoothValue);
        
        // Calculate moving average
        const smoothedValue = videoSawtooth.reduce((sum, val) => sum + val, 0) / videoSawtooth.length;
        
        return smoothedValue;
    }

    // Draw RMS waveform
    function drawWaveformLine(ctx, canvas, historyData, color, normalizeY = value => value) {
        if (historyData.length <= 1) return;
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.beginPath();
        const sliceWidth = (canvas.width - 30) / (historyData.length - 1);
        for (let i = 0; i < historyData.length; i++) {
            const y = canvas.height - (normalizeY(historyData[i]) * canvas.height);
            i === 0 ? ctx.moveTo(30, y) : ctx.lineTo(i * sliceWidth + 30, y);
        }
        ctx.stroke();
    }

    // Send command to serial port
    const sendPositionToSerial = async () => {
        if (!navigator.serial || !window.selectedSerialPort) return;
        try {
            if (!window.selectedSerialPort.readable) await window.selectedSerialPort.open({ baudRate: 115200 });
            const writer = window.selectedSerialPort.writable.getWriter();
            const tcodeCmd = `L0${currentPos}I50\n`;
            // console.log('[tcode]', tcodeCmd);
            await writer.write(new TextEncoder().encode(tcodeCmd));
            writer.releaseLock();
        } catch (e) { console.error('Failed to send serial command:', e); }
    };

    // Map beat frequency (Hz) to sawtooth frequency (Hz) with softer compression at high tempos
    const calculateY = x => x <= 4 ? x : (x <= 16 ? x / 4 : Math.pow(x-2, 1/4) + 1);
})();
