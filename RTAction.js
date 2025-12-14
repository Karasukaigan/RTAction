// ==UserScript==
// @name         RTAction
// @namespace    http://tampermonkey.net/
// @version      1.1
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
    window.videoElement = null; // 主视频
    var videoMs = 0; // 当前毫秒数
    let currentTargets = [0, 1]; // RMS值分段
    var videoRms = [0, 0, 0, 0, 0]; // 存储最近5个RMS值
    let getVideoElementButton = null; // 获取视频元素按钮

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

    // 根据趋势返回最大值或最小值
    const analyzeTrend = (values) => {
        let diffSum = 0;
        for (let i = 1; i < values.length; i++) {
            diffSum += values[i] - values[i - 1];
        }
        if (diffSum > 0) {
            // 总体上升，返回最大值
            return Math.max(...values);
        } else {
            // 总体下降或持平，返回最小值
            return Math.min(...values);
        }
    };

    // 线性映射值到新的范围
    const mapValue = (value, min = 0, max = 1, newMin = 0, newMax = 9999) => {
        const clampedValue = Math.min(Math.max(value, min), max);
        const mappedValue = ((clampedValue - min) / (max - min)) * (newMax - newMin) + newMin;
        return mappedValue;
    };

    // 计算位置
    const calcPos = () => {
        previousPos = currentPos;
        currentPos = Math.round(mapValue(1 - analyzeTrend(videoRms)));
        // console.log('pos:', currentPos);
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

    // 页面卸载时执行清理
    window.addEventListener('beforeunload', cleanup);

    // 创建控制面板
    function createControlPanel() {
        // 面板容器
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

        // 语言切换按钮
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

        // 测试连接功能
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

        // 绑定事件
        refreshPortsButton.addEventListener('click', refreshSerialPorts);
        testConnectionButton.addEventListener('click', testConnection);

        // 按钮
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
        
        // 结果显示区域
        const timeInfoDiv = document.createElement('div');
        timeInfoDiv.id = 'time-info';
        timeInfoDiv.style.cssText = `
            font-size: 13px;
            line-height: 1.5;
            color: #495057;
            background: #f8f9fa;
            padding: 12px;
            border-radius: 6px;
            border: 1px solid #e9ecef;
            margin-top: 8px;
            margin-bottom: 10px;
            min-height: 80px;
            white-space: pre;
            display: none;
        `;

        const targetSelect = document.createElement('select');
        targetSelect.id = 'target-selection';
        targetSelect.style.cssText = `
            width: 100%;
            padding: 8px;
            border-radius: 6px;
            border: 1px solid #ced4da;
            background-color: #fff;
            font-size: 13px;
            margin-bottom: 10px;
        `;

        const options = [
            { value: "0,1", text: "0, 9999" },
            { value: "0.2,1", text: "0, 8000" },
            { value: "raw", text: "Raw" },
            { value: "0,0.5,1", text: "0, 5000, 9999" },
            { value: "0,0.3,0.7,1", text: "0, 3000, 7000, 9999" }
        ];
        options.forEach(option => {
            const opt = document.createElement('option');
            opt.value = option.value;
            opt.textContent = option.text;
            targetSelect.appendChild(opt);
        });
        targetSelect.value = "0,1";

        targetSelect.addEventListener('change', function() {
            switch(this.value) {
                case "0,1":
                    currentTargets = [0, 1];
                    break;
                case "0.2,1":
                    currentTargets = [0.2, 1];
                    break;
                case "raw":
                    currentTargets = [];
                    break;
                case "0,0.5,1":
                    currentTargets = [0, 0.5, 1];
                    break;
                case "0,0.3,0.7,1":
                    currentTargets = [0, 0.3, 0.7, 1];
                    break;
                default:
                    currentTargets = [0, 1];
            }
        });

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
        content.appendChild(timeInfoDiv);
        content.appendChild(targetSelect);
        content.appendChild(audioWaveformDiv);

        panel.appendChild(header);
        panel.appendChild(content);

        document.body.appendChild(panel);

        // 折叠展开功能
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

        // 更新结果
        const updateTimeInfo = (text, color) => {
            timeInfoDiv.textContent = text;
            timeInfoDiv.style.color = color;
        };

        // 按钮点击事件
        button.addEventListener('click', () => {
            try {
                cleanup();

                // 查找视频元素
                let videoWrapSelector = '.bpx-player-video-wrap';
                if (domain.includes("youtube")) {
                    videoWrapSelector = '.html5-video-container';
                }
                const videoWrap = document.querySelector(videoWrapSelector);
                const video = videoWrap.querySelector('video');
                if (!video) {
                    updateTimeInfo('未找到视频元素', '#dc3545');
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
                                
                                // 计算RMS值来平滑波形
                                const rmsValue = calculateRMS(currentData);
                                
                                // 添加到历史数据 (存储RMS值而不是整个数组)
                                historyData.push(rmsValue);
                                if (historyData.length > maxFrames) {
                                    historyData.shift();
                                }
                                
                                // 清空画布
                                ctx.fillStyle = '#f8f9fa';
                                ctx.fillRect(0, 0, canvas.width, canvas.height);
                                
                                // 绘制纵坐标值
                                ctx.fillStyle = '#6c757d';
                                ctx.font = '10px Arial';
                                ctx.textAlign = 'right';
                                // ctx.fillText('1.0', 20, 10);
                                // ctx.fillText('0.5', 20, canvas.height/2);
                                // ctx.fillText('0.0', 20, canvas.height - 2);
                                ctx.fillText('0', 25, 10);
                                ctx.fillText('5000', 25, canvas.height/2);
                                ctx.fillText('9999', 25, canvas.height - 2);
                                
                                // 绘制简化波形
                                if (historyData.length > 1) {
                                    ctx.lineWidth = 2;
                                    ctx.strokeStyle = '#0d6efd';
                                    ctx.beginPath();
                                    
                                    const sliceWidth = (canvas.width - 30) / (historyData.length - 1); // 调整宽度以留出纵坐标空间
                                    
                                    for (let i = 0; i < historyData.length; i++) {
                                        // 将RMS值(0-1范围)映射到画布高度
                                        const y = canvas.height - (historyData[i] * canvas.height);
                                        
                                        if (i === 0) {
                                            ctx.moveTo(30, y); // 从30px开始绘制，为纵坐标留出空间
                                        } else {
                                            ctx.lineTo(i * sliceWidth + 30, y); // 同样偏移30px
                                        }
                                    }
                                    
                                    ctx.stroke();
                                }
                                
                                // 绘制中心线
                                ctx.lineWidth = 1;
                                ctx.strokeStyle = '#adb5bd';
                                ctx.beginPath();
                                ctx.moveTo(30, canvas.height / 2); // 调整起始点
                                ctx.lineTo(canvas.width, canvas.height / 2);
                                ctx.stroke();
                                
                                requestAnimationFrame(drawWaveform);
                            }
                            
                            drawWaveform(); // 开始绘制
                        } catch (e) {
                            waveformDisplay.innerHTML = `<div style="text-align:center;color:#dc3545;">音频分析失败: ${e.message}</div>`;
                            console.error('音频分析错误:', e);
                        }
                    }, 100);
                }

                // 显示基本信息
                updateTimeInfo(`总时长: 00:00\n当前时间: 00:00 (${videoMs}ms)\n位置: ${currentPos}\n状态: 准备就绪`, '#495057');
              
                // 更新时间显示的函数
                const updateTimeDisplay = () => {
                    videoMs = Math.round(video.currentTime * 1000);
                    const status = video.paused ? '已暂停' : '正在播放';
                    if (!video.paused) {
                        calcPos();
                        if (previousPos !== currentPos) {
                            sendPositionToSerial();
                        }
                    }
                    updateTimeInfo(`总时长: ${formatTime(video.duration)}\n当前时间: ${formatTime(video.currentTime)} (${videoMs}ms)\n位置: ${currentPos}\n状态: ${status}`, '#495057');
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

                // 使用 setInterval 每150ms执行一次更新
                window.videoUpdateInterval = setInterval(updateTimeDisplay, 150);

                // 初始更新
                updateTimeDisplay();
            } catch (error) {
                updateTimeInfo(`发生错误: ${error.message}`, '#dc3545');
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

    // 等待页面加载完成后创建面板
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createControlPanel);
    } else {
        createControlPanel();
    }

    // 添加一些样式
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
            const normalized = (data[i] - 128) / 128; // 转换为-1到1范围
            sum += normalized * normalized;
        }
        let rms = Math.sqrt(sum / data.length);
        let result = Math.min(rms * 4, 1); // 放大4倍，但不超过1
        result = findClosestValue(result);
        videoRms.shift(); // 删除第一个元素（最旧的）
        videoRms.push(result); // 在末尾添加新的RMS值
        // console.log(`RMS: ${videoRms}`);
        return result;
    }

    // 格式化时间
    const formatTime = (seconds) => {
        if (isNaN(seconds) || seconds < 0) return '00:00:00';
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    // 发送位置信息到串口
    const sendPositionToSerial = async () => {
        if (!navigator.serial || !window.selectedSerialPort) {
            return;
        }
        try {
            if (!window.selectedSerialPort.readable) {
                await window.selectedSerialPort.open({ baudRate: 115200 });
            }
            const message = `L0${currentPos}I150\n`;
            const writer = window.selectedSerialPort.writable.getWriter();
            const encoder = new TextEncoder();
            await writer.write(encoder.encode(message));
            writer.releaseLock();
        } catch (error) {
            console.error('发送位置信息失败:', error);
        }
    };
})();