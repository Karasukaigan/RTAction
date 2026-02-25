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

    const domain = window.location.hostname; // Domain name
    let currentPos = 5000; // Current position
    let previousPos = 9999; // Previous position
    let getVideoElementButton = null;
    window.videoElement = null; // Main video
    let currentTargets = []; // RMS value segments, actually deprecated
    var videoRms = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // Last 10 RMS values
    var videoSawtooth = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // Last 10 sawtooth wave values
    var previousRms = 0; // Previous RMS value
    var rmsRising = false; // Whether RMS value is in rising phase
    var sawtoothSkew = 0.6; // Skewness, 0 for reverse ramp, 0.5 for triangle wave, 1 for forward ramp
    var sawtoothPhase = 0; // Sawtooth wave phase
    var sawtoothAmplitude = 0; // Sawtooth wave amplitude
    var sawtoothFrequency = 0.3; // Sawtooth wave frequency
    var rmsAmplification = 4; // RMS amplification factor
    var beatHistory = []; // Recent beat timestamps
    
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

    // Calculate position
    const calcPos = () => {
        previousPos = currentPos;
        const isSawtoothMode = document.getElementById('waveform-sawtooth') && document.getElementById('waveform-sawtooth').checked;
        if (isSawtoothMode) {
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
            
            // Calculate RMS value and sawtooth wave value
            const rmsValue = calculateRMS(currentData);
            const sawtoothValue = calculateSawtooth(rmsValue, Date.now());
            
            // Record historical values
            if (document.getElementById('waveform-sawtooth').checked) {
                historyData.push(sawtoothValue);
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
                // Draw sawtooth waveform
                drawSawtoothWaveform(ctx, canvas, historyData);
            } else {
                // Draw RMS waveform
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

                // Reset sawtooth wave related variables
                previousRms = 0;
                sawtoothPhase = 0;
                sawtoothAmplitude = 0;
                sawtoothFrequency = 0.3;
                videoSawtooth = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

                // Find video element
                const selectors = {
                    'youtube': '.html5-video-container',
                    'live.bilibili': '.live-player-mounter',
                    'tiktok': '.xgplayer-container',
                    'twitch': '.video-player__container',
                    'nicovideo': '.PlayerPresenter'
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

    // Calculate sawtooth wave
    function calculateSawtooth(rmsValue, currentTime = Date.now()) {
        // Detect beats (whether RMS value significantly increases)
        const rmsChange = rmsValue - previousRms;
        const thresholdForBeat = 0.2; // Beat detection threshold (cumulative change amount)
        
        if (rmsValue > previousRms) {
            // Rising phase
            if (!rmsRising) {
                rmsRising = true;
                window.rmsAccumulatedIncrease = rmsChange;
            } else {
                window.rmsAccumulatedIncrease = (window.rmsAccumulatedIncrease || 0) + rmsChange;
            }
        } else {
            // Transition from rising to falling, check if beat threshold is reached
            if (rmsRising && window.rmsAccumulatedIncrease && window.rmsAccumulatedIncrease >= thresholdForBeat) {
                const now = currentTime;
                beatHistory.push(now);
                const twoSecondsAgo = now - 1500; // 1500ms interval
                beatHistory = beatHistory.filter(time => time > twoSecondsAgo);
                
                if (beatHistory.length > 1) {
                    const timeSpan = beatHistory[beatHistory.length - 1] - beatHistory[0];
                    if (timeSpan > 0) {
                        const beatFrequencyRaw = (beatHistory.length - 1) / (timeSpan / 1000); // Beats per second
                        const beatFrequency = Math.round(calculateY(beatFrequencyRaw) * 100) / 100;
                        let calculatedFrequency = beatFrequency; // Sawtooth wave frequency
                        calculatedFrequency = Math.max(0.1, Math.min(calculatedFrequency, 4));
                        sawtoothFrequency = calculatedFrequency;
                        sawtoothSkew = sawtoothFrequency > 2 ? 0.5 : 0.6;
                        // console.log(`[RMS ${rmsValue}] ${beatFrequencyRaw} -> ${beatFrequency} -> ${calculatedFrequency}`);
                    }
                } else if (beatHistory.length === 1) {
                    sawtoothFrequency = 0.3; // Only one beat, use default frequency
                }
            }
            // End rising phase
            rmsRising = false;
            window.rmsAccumulatedIncrease = 0; // Reset accumulated rise value
        }
    
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

    // Draw sawtooth waveform
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

    const calculateY = x => x <= 4 ? x : (x <= 16 ? x / 4 : Math.pow(x-2, 1/4) + 1);
})();