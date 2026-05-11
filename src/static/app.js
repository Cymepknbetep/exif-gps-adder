/**
 * EXIF GPS 编辑器前端（本地处理模式）。
 *
 * 浏览器纯 UI，Python 后端直接读写本地文件。
 */

(function () {
    'use strict';

    // DOM 引用
    const sourceInput = document.getElementById('sourceInput');
    const outputInput = document.getElementById('outputInput');
    const pickSourceBtn = document.getElementById('pickSourceBtn');
    const pickOutputBtn = document.getElementById('pickOutputBtn');
    const scanBtn = document.getElementById('scanBtn');
    const genThumbBtn = document.getElementById('genThumbBtn');
    const selectAllCheckbox = document.getElementById('selectAllCheckbox');
    const rangeSelectBtn = document.getElementById('rangeSelectBtn');
    const deleteBtn = document.getElementById('deleteBtn');
    const fileCountLabel = document.getElementById('fileCountLabel');
    const fileTableBody = document.getElementById('fileTableBody');
    const emptyHint = document.getElementById('emptyHint');
    const latInput = document.getElementById('latInput');
    const lngInput = document.getElementById('lngInput');
    const altInput = document.getElementById('altInput');
    const toggleMapBtn = document.getElementById('toggleMapBtn');
    const mapContainer = document.getElementById('mapContainer');
    const addTaskBtn = document.getElementById('addTaskBtn');
    const addTaskBadge = document.getElementById('addTaskBadge');
    const taskQueue = document.getElementById('taskQueue');
    const taskQueueCount = document.getElementById('taskQueueCount');
    const startBtn = document.getElementById('startBtn');
    const openOutputBtn = document.getElementById('openOutputBtn');
    const statusDiv = document.getElementById('status');
    const coordModeCheckbox = document.getElementById('coordModeCheckbox');

    // 状态
    let fileItems = [];   // { id, name, size, status, selected, hasThumb, thumbUrl }
    let tasks = [];       // { id, indices, lat, lng, alt }
    let nextTaskId = 1;
    let nextColorIdx = 0;
    let map = null;
    let mapMarker = null;
    let lastGcjLat = null;
    let lastGcjLng = null;
    let isScanning = false;

    const STORAGE_KEY_MAP = 'exif_gps_last_map_view';
    const STORAGE_KEY_MARKER = 'exif_gps_last_marker';
    const STORAGE_KEY_SOURCE = 'exif_gps_source_dir';
    const STORAGE_KEY_OUTPUT = 'exif_gps_output_dir';

    const TASK_COLORS = [
        '#ef4444', '#f59e0b', '#10b981', '#3b82f6',
        '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16',
    ];

    function init() {
        bindEvents();
        loadSavedDirs();
        if (!('showDirectoryPicker' in window)) {
            pickSourceBtn.style.display = 'none';
            pickOutputBtn.style.display = 'none';
        }
        updateUI();
    }

    function bindEvents() {
        pickSourceBtn.addEventListener('click', () => pickFolder('source'));
        pickOutputBtn.addEventListener('click', () => pickFolder('output'));
        scanBtn.addEventListener('click', onScan);
        genThumbBtn.addEventListener('click', onGenerateThumbs);
        selectAllCheckbox.addEventListener('change', onSelectAll);
        rangeSelectBtn.addEventListener('click', onRangeSelect);
        toggleMapBtn.addEventListener('click', onToggleMap);
        addTaskBtn.addEventListener('click', onAddTask);
        startBtn.addEventListener('click', onStart);
        openOutputBtn.addEventListener('click', onOpenOutputDir);
        [latInput, lngInput].forEach(el => el.addEventListener('input', updateUI));
    }

    // ================================================================
    // 文件夹选择（File System Access API + 手动输入）
    // ================================================================

    async function pickFolder(field) {
        // 优先尝试后端弹出真正的系统文件夹选择对话框
        try {
            showStatus('请在弹出的系统对话框中选择文件夹（30秒内）...', 'loading');
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 32000);
            const resp = await fetch('/api/pick-folder', {
                method: 'GET',
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            const data = await resp.json();
            if (data.cancelled) {
                showStatus('已取消选择', 'error');
                return;
            }
            if (data.timeout) {
                showStatus('选择对话框超时（30秒），已自动取消。请手动粘贴路径', 'error');
                return;
            }
            if (data.error) {
                throw new Error(data.error);
            }
            if (data.path) {
                const input = field === 'source' ? sourceInput : outputInput;
                input.value = data.path;
                saveDirs();
                showStatus(`已选择: ${data.path}`, 'success');
                return;
            }
        } catch (e) {
            if (e.name === 'AbortError') {
                showStatus('选择对话框超时', 'error');
                return;
            }
            // 后端不可用，fallback 到浏览器 File System Access API
            console.log('后端弹框失败，fallback:', e);
        }

        // Fallback: 浏览器 File System Access API（拿不到绝对路径）
        if (!('showDirectoryPicker' in window)) {
            showStatus('您的浏览器不支持文件夹选择，请手动粘贴绝对路径', 'error');
            return;
        }
        try {
            const dirHandle = await window.showDirectoryPicker();
            const hint = dirHandle.name;
            showStatus(`已选择文件夹: ${hint}，请将该文件夹的绝对路径（如 D:\\Photos\\${hint}）粘贴到上方输入框`, 'success');
        } catch (e) {
            if (e.name !== 'AbortError') {
                showStatus('选择文件夹失败: ' + e.message, 'error');
            }
        }
    }

    function loadSavedDirs() {
        try {
            const s = localStorage.getItem(STORAGE_KEY_SOURCE);
            const o = localStorage.getItem(STORAGE_KEY_OUTPUT);
            if (s) sourceInput.value = s;
            if (o) outputInput.value = o;
        } catch (e) { /* ignore */ }
    }

    function saveDirs() {
        try {
            localStorage.setItem(STORAGE_KEY_SOURCE, sourceInput.value);
            localStorage.setItem(STORAGE_KEY_OUTPUT, outputInput.value);
        } catch (e) { /* ignore */ }
    }

    // ================================================================
    // 扫描文件
    // ================================================================

    async function onScan() {
        const source = sourceInput.value.trim();
        const output = outputInput.value.trim();
        if (!source) { showStatus('请先填写源文件夹路径', 'error'); return; }

        saveDirs();
        isScanning = true;
        scanBtn.disabled = true;
        showStatus('正在扫描...', 'loading');

        try {
            // 先保存配置
            const configForm = new FormData();
            configForm.append('source', source);
            if (output) configForm.append('output', output);
            await fetch('/api/config', { method: 'POST', body: configForm });

            // 获取文件列表
            const resp = await fetch('/api/files');
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.detail || '扫描失败');

            fileItems = data.files.map((f, idx) => ({
                id: idx + 1,
                name: f.name,
                size: f.size,
                status: 'idle',
                selected: false,
                hasThumb: f.hasThumb,
                thumbUrl: f.thumbUrl,
            }));

            renderFileList();
            updateUI();
            showStatus(`扫描完成，共 ${data.count} 个图片文件`, 'success');
        } catch (err) {
            showStatus('扫描失败: ' + err.message, 'error');
        } finally {
            isScanning = false;
            scanBtn.disabled = false;
        }
    }

    async function onGenerateThumbs() {
        if (fileItems.length === 0) { showStatus('请先扫描文件', 'error'); return; }
        genThumbBtn.disabled = true;
        showStatus('正在生成缩略图...', 'loading');
        try {
            const resp = await fetch('/api/thumbs/generate', { method: 'POST' });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.detail || '生成失败');
            // 刷新列表获取新的缩略图 URL
            await onScan();
            showStatus(`缩略图生成完成: ${data.generated} 成功, ${data.failed} 失败`, 'success');
        } catch (err) {
            showStatus('生成缩略图失败: ' + err.message, 'error');
        } finally {
            genThumbBtn.disabled = false;
        }
    }

    // ================================================================
    // 文件列表渲染
    // ================================================================

    function renderFileList() {
        fileCountLabel.textContent = `${fileItems.length} 个文件`;
        if (fileItems.length === 0) {
            fileTableBody.innerHTML = '';
            emptyHint.style.display = 'block';
            return;
        }
        emptyHint.style.display = 'none';

        const BATCH_RENDER = 40;
        if (fileItems.length > BATCH_RENDER) {
            _renderFileListBatched(BATCH_RENDER);
            return;
        }
        _renderFileListImmediate();
    }

    function _getTaskForFileIndex(idx) {
        return tasks.find(t => t.indices.includes(idx));
    }

    function _buildRowHtml(item, idx) {
        const sizeMB = (item.size / 1024 / 1024).toFixed(2);
        const checked = item.selected ? 'checked' : '';
        let statusHtml = '';
        if (item.status === 'done') {
            statusHtml = '<span class="status-icon status-done">✓</span>';
        } else {
            const task = _getTaskForFileIndex(idx);
            if (task) {
                const color = TASK_COLORS[(task.colorIdx || 0) % TASK_COLORS.length];
                statusHtml = `<span class="status-icon" style="color:${color}" title="已添加到任务">●</span>`;
            }
        }

        let thumbHtml;
        if (item.hasThumb && item.thumbUrl) {
            thumbHtml = `<img class="thumb-img" src="${item.thumbUrl}" alt="" loading="lazy">`;
        } else {
            thumbHtml = `<div class="thumb-placeholder">📷</div>`;
        }

        return `<tr class="${item.selected ? 'selected' : ''}" data-id="${item.id}">
            <td><input type="checkbox" class="row-checkbox" data-id="${item.id}" ${checked}></td>
            <td class="thumb-cell">${thumbHtml}</td>
            <td class="file-name-cell" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</td>
            <td class="file-size-cell">${sizeMB} MB</td>
            <td>${statusHtml}</td>
        </tr>`;
    }

    function _renderFileListImmediate() {
        let html = '';
        for (let i = 0; i < fileItems.length; i++) {
            html += _buildRowHtml(fileItems[i], i);
        }
        fileTableBody.innerHTML = html;
        _bindRowEvents();
    }

    let _pendingRafId = null;

    function _renderFileListBatched(batchSize) {
        if (_pendingRafId !== null) {
            cancelAnimationFrame(_pendingRafId);
            _pendingRafId = null;
        }
        fileTableBody.innerHTML = '';
        let index = 0;

        function renderChunk() {
            _pendingRafId = null;
            const chunk = fileItems.slice(index, index + batchSize);
            const fragment = document.createDocumentFragment();
            const wrapper = document.createElement('tbody');
            wrapper.innerHTML = chunk.map((item, offset) => _buildRowHtml(item, index + offset)).join('');
            while (wrapper.firstChild) {
                fragment.appendChild(wrapper.firstChild);
            }
            fileTableBody.appendChild(fragment);
            index += batchSize;

            if (index < fileItems.length) {
                _pendingRafId = requestAnimationFrame(renderChunk);
            } else {
                _bindRowEvents();
            }
        }
        _pendingRafId = requestAnimationFrame(renderChunk);
    }

    function _bindRowEvents() {
        fileTableBody.querySelectorAll('.row-checkbox').forEach(cb => {
            cb.addEventListener('change', function (e) {
                e.stopPropagation();
                const id = parseInt(this.dataset.id);
                _toggleSelection(id, this.checked);
            });
        });

        fileTableBody.querySelectorAll('tr').forEach(tr => {
            tr.addEventListener('click', function (e) {
                if (e.target.tagName === 'INPUT') return;
                const id = parseInt(this.dataset.id);
                const item = fileItems.find(f => f.id === id);
                if (item) _toggleSelection(id, !item.selected);
            });
        });
    }

    function _toggleSelection(id, selected) {
        const item = fileItems.find(f => f.id === id);
        if (!item || item.selected === selected) return;
        item.selected = selected;
        const tr = fileTableBody.querySelector(`tr[data-id="${id}"]`);
        if (tr) {
            tr.classList.toggle('selected', selected);
            const cb = tr.querySelector('.row-checkbox');
            if (cb) cb.checked = selected;
        }
        updateUI();
    }

    function onSelectAll() {
        const checked = selectAllCheckbox.checked;
        fileItems.forEach(item => {
            item.selected = checked;
            const tr = fileTableBody.querySelector(`tr[data-id="${item.id}"]`);
            if (tr) {
                tr.classList.toggle('selected', checked);
                const cb = tr.querySelector('.row-checkbox');
                if (cb) cb.checked = checked;
            }
        });
        updateUI();
    }

    function onRangeSelect() {
        const selected = fileItems.filter(f => f.selected);
        if (selected.length < 2) {
            showStatus('请至少先选中 2 张图片', 'error');
            return;
        }
        const indices = selected.map(s => fileItems.indexOf(s)).sort((a, b) => a - b);
        const minIdx = indices[0];
        const maxIdx = indices[indices.length - 1];
        for (let i = minIdx; i <= maxIdx; i++) {
            const item = fileItems[i];
            if (!item.selected) {
                item.selected = true;
                const tr = fileTableBody.querySelector(`tr[data-id="${item.id}"]`);
                if (tr) {
                    tr.classList.add('selected');
                    const cb = tr.querySelector('.row-checkbox');
                    if (cb) cb.checked = true;
                }
            }
        }
        updateUI();
        showStatus(`已选中第 ${minIdx + 1} 到第 ${maxIdx + 1} 张之间的所有图片`, 'success');
    }

    // ================================================================
    // 任务队列
    // ================================================================

    function onAddTask() {
        const selectedIndices = [];
        fileItems.forEach((f, idx) => { if (f.selected) selectedIndices.push(idx); });
        if (selectedIndices.length === 0) { showStatus('请先勾选要添加的图片', 'error'); return; }

        const lat = parseFloat(latInput.value);
        const lng = parseFloat(lngInput.value);
        const alt = altInput.value.trim() === '' ? null : parseFloat(altInput.value);

        if (isNaN(lat) || isNaN(lng)) { showStatus('请输入有效的经纬度', 'error'); return; }
        if (lat < -90 || lat > 90) { showStatus('纬度必须在 -90 ~ 90 之间', 'error'); return; }
        if (lng < -180 || lng > 180) { showStatus('经度必须在 -180 ~ 180 之间', 'error'); return; }

        // 如果选中的图片已在其他任务中，先从旧任务移除
        tasks.forEach(t => {
            t.indices = t.indices.filter(idx => !selectedIndices.includes(idx));
        });
        tasks = tasks.filter(t => t.indices.length > 0);

        tasks.push({ id: nextTaskId++, indices: selectedIndices, lat, lng, alt, colorIdx: nextColorIdx++ });

        fileItems.forEach(f => f.selected = false);
        renderFileList();
        renderTaskQueue();
        updateUI();
        showStatus(`已添加任务：${selectedIndices.length} 张图片`, 'success');
    }

    function renderTaskQueue() {
        taskQueueCount.textContent = tasks.length;
        if (tasks.length === 0) {
            taskQueue.innerHTML = '<div class="task-empty">暂无任务</div>';
            return;
        }
        let html = '';
        for (const task of tasks) {
            const fileNames = task.indices
                .map(idx => fileItems[idx])
                .filter(Boolean)
                .map(f => f.name);
            const displayNames = fileNames.length <= 2
                ? fileNames.join(', ')
                : fileNames.slice(0, 2).join(', ') + ` 等 ${fileNames.length} 张`;
            const color = TASK_COLORS[(task.colorIdx || 0) % TASK_COLORS.length];
            html += `<div class="task-item" data-task-id="${task.id}">
                <div class="task-color-bar" style="background:${color}"></div>
                <div class="task-info">
                    <div class="task-coord">${task.lat.toFixed(4)}, ${task.lng.toFixed(4)}${task.alt !== null ? ', ' + task.alt + 'm' : ''}</div>
                    <div class="task-files">${escapeHtml(displayNames)}</div>
                </div>
                <button class="task-remove" data-task-id="${task.id}">×</button>
            </div>`;
        }
        taskQueue.innerHTML = html;

        taskQueue.querySelectorAll('.task-remove').forEach(btn => {
            btn.addEventListener('click', function () {
                const taskId = parseInt(this.dataset.taskId);
                tasks = tasks.filter(t => t.id !== taskId);
                renderTaskQueue();
                updateUI();
            });
        });
    }

    // ================================================================
    // 开始处理（本地文件模式）
    // ================================================================

    async function onStart() {
        if (tasks.length === 0) { showStatus('任务队列为空', 'error'); return; }

        const MAX_BATCH_COUNT = 20;
        const MAX_BATCH_BYTES = 150 * 1024 * 1024;
        const MAX_PARALLEL_BATCHES = 3;
        startBtn.disabled = true;
        let totalProcessed = 0;

        // 按数量和大小双重限制拆分批次
        function splitIntoBatches(indices, maxCount, maxBytes) {
            const batches = [];
            let current = [];
            let currentSize = 0;
            for (const idx of indices) {
                const item = fileItems[idx];
                if (!item) continue;
                const wouldExceedCount = current.length >= maxCount;
                const wouldExceedSize = current.length > 0 && currentSize + item.size > maxBytes;
                if (wouldExceedCount || wouldExceedSize) {
                    batches.push(current);
                    current = [];
                    currentSize = 0;
                }
                current.push(idx);
                currentSize += item.size;
            }
            if (current.length > 0) batches.push(current);
            return batches;
        }

        // 收集所有任务的所有批次
        const allWork = [];
        for (let i = 0; i < tasks.length; i++) {
            const task = tasks[i];
            if (task.indices.length === 0) continue;
            const batches = splitIntoBatches(task.indices, MAX_BATCH_COUNT, MAX_BATCH_BYTES);
            batches.forEach((batch, bIdx) => {
                allWork.push({ taskIndex: i, batchIndex: bIdx, batch, task, totalBatches: batches.length });
            });
        }

        if (allWork.length === 0) { startBtn.disabled = false; return; }

        let completedWork = 0;

        async function processOne(work) {
            const { taskIndex, batchIndex, batch, task, totalBatches } = work;
            const batchInfo = totalBatches > 1
                ? `任务 ${taskIndex + 1} 第 ${batchIndex + 1}/${totalBatches} 批（${batch.length} 张）`
                : `任务 ${taskIndex + 1}（${batch.length} 张）`;
            showStatus(`正在处理 ${batchInfo}...（${completedWork}/${allWork.length}）`, 'loading');

            const formData = new FormData();
            for (const idx of batch) formData.append('indices', idx);
            formData.append('lat', task.lat);
            formData.append('lng', task.lng);
            if (task.alt !== null) formData.append('altitude', task.alt);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 600000);
            try {
                const response = await fetch('/api/gps/write_local', {
                    method: 'POST',
                    body: formData,
                    signal: controller.signal,
                });
                clearTimeout(timeoutId);

                if (!response.ok) {
                    const text = await response.text();
                    throw new Error(text || `HTTP ${response.status}`);
                }
                const result = await response.json();

                // 标记为已完成，直接更新对应行状态，避免完整重渲染导致竞态
                for (const idx of batch) {
                    const item = fileItems[idx];
                    if (item) {
                        item.status = 'done';
                        const tr = fileTableBody.querySelector(`tr[data-id="${item.id}"]`);
                        if (tr) {
                            const statusCell = tr.querySelector('td:last-child');
                            if (statusCell) statusCell.innerHTML = '<span class="status-icon status-done">✓</span>';
                        }
                    }
                }
                totalProcessed += result.processed;
                completedWork++;
            } catch (err) {
                clearTimeout(timeoutId);
                throw err;
            }
        }

        try {
            await runWithConcurrency(allWork, MAX_PARALLEL_BATCHES, processOne);
        } catch (err) {
            showStatus(`处理失败: ${err.name === 'AbortError' ? '请求超时' : err.message}`, 'error');
            startBtn.disabled = false;
            renderFileList();
            updateUI();
            return;
        }

        tasks = [];
        nextColorIdx = 0;
        renderTaskQueue();
        renderFileList();
        updateUI();
        const outputDir = outputInput.value.trim() || '下载目录';
        showStatus(`全部完成！共处理 ${totalProcessed} 张图片。输出位置: ${outputDir}`, 'success');
        openOutputBtn.style.display = 'inline-block';
        startBtn.disabled = false;
    }

    function onOpenOutputDir() {
        const output = outputInput.value.trim();
        if (!output) {
            showStatus('未指定输出目录，文件已输出到系统下载目录，请手动打开', 'success');
            return;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(output).then(() => {
                showStatus(`输出目录路径已复制到剪贴板: ${output}，请在资源管理器地址栏粘贴后按回车打开`, 'success');
            }).catch(() => {
                showStatus(`输出目录: ${output}，请手动在资源管理器中打开`, 'success');
            });
        } else {
            showStatus(`输出目录: ${output}，请手动在资源管理器中打开`, 'success');
        }
    }

    async function runWithConcurrency(items, limit, fn) {
        let index = 0;
        async function worker() {
            while (index < items.length) {
                const i = index++;
                await fn(items[i]);
            }
        }
        const workers = [];
        for (let i = 0; i < Math.min(limit, items.length); i++) {
            workers.push(worker());
        }
        await Promise.all(workers);
    }

    // ================================================================
    // 地图
    // ================================================================

    function onToggleMap() {
        const isHidden = mapContainer.classList.contains('hidden');
        if (isHidden) {
            mapContainer.classList.remove('hidden');
            toggleMapBtn.textContent = '隐藏地图';
            requestAnimationFrame(() => setTimeout(() => initMap(), 150));
        } else {
            saveMapView();
            mapContainer.classList.add('hidden');
            toggleMapBtn.textContent = '在地图上选点';
        }
    }

    function getSavedMapView() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY_MAP);
            if (raw) {
                const p = JSON.parse(raw);
                if (typeof p.lat === 'number' && typeof p.lng === 'number' && typeof p.zoom === 'number') return p;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function saveMapView() {
        if (!map) return;
        const c = map.getCenter();
        localStorage.setItem(STORAGE_KEY_MAP, JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
    }

    function initMap() {
        if (map) { map.invalidateSize(); return; }
        const s = getSavedMapView();
        map = L.map('map').setView([s ? s.lat : 39.9042, s ? s.lng : 116.4074], s ? s.zoom : 12);

        const mainLayer = L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
            attribution: '&copy; 高德地图', maxZoom: 18, subdomains: '1234',
        });
        const fallbackLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; CartoDB, &copy; OpenStreetMap contributors', maxZoom: 19, subdomains: 'abcd',
        });
        let errCount = 0;
        mainLayer.on('tileerror', () => {
            errCount++;
            if (errCount > 3 && map.hasLayer(mainLayer)) {
                map.removeLayer(mainLayer); fallbackLayer.addTo(map);
                const el = document.getElementById('mapError');
                if (el) { el.textContent = '主地图加载失败，已自动切换备选源。'; el.style.display = 'block'; }
            }
        });
        mainLayer.addTo(map);

        try {
            const sm = localStorage.getItem(STORAGE_KEY_MARKER);
            if (sm) { const m = JSON.parse(sm); if (typeof m.lat === 'number' && typeof m.lng === 'number') updateMapMarker(m.lat, m.lng); }
        } catch (e) { /* ignore */ }

        map.on('click', e => {
            const gcjLat = e.latlng.lat, gcjLng = e.latlng.lng;
            lastGcjLat = gcjLat; lastGcjLng = gcjLng;
            updateInputsFromGcj(gcjLat, gcjLng);
            updateMapMarker(gcjLat, gcjLng);
            updateUI();
            localStorage.setItem(STORAGE_KEY_MARKER, JSON.stringify({ lat: gcjLat, lng: gcjLng }));
            saveMapView();
        });
        map.on('moveend', saveMapView);
    }

    function updateMapMarker(lat, lng) {
        if (!map) return;
        if (mapMarker) mapMarker.setLatLng([lat, lng]);
        else mapMarker = L.marker([lat, lng]).addTo(map);
        map.panTo([lat, lng]);
    }

    function updateInputsFromGcj(gcjLat, gcjLng) {
        if (coordModeCheckbox && coordModeCheckbox.checked) {
            latInput.value = gcjLat.toFixed(6);
            lngInput.value = gcjLng.toFixed(6);
        } else {
            const wgs = gcj02ToWgs84(gcjLng, gcjLat);
            latInput.value = wgs[1].toFixed(6);
            lngInput.value = wgs[0].toFixed(6);
        }
    }

    function gcj02ToWgs84(lng, lat) {
        const PI = 3.1415926535897932384626, a = 6378245.0, ee = 0.00669342162296594323;
        function transformlat(lng, lat) {
            let ret = -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat + 0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng));
            ret += (20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0 / 3.0;
            ret += (20.0 * Math.sin(lat * PI) + 40.0 * Math.sin(lat / 3.0 * PI)) * 2.0 / 3.0;
            ret += (160.0 * Math.sin(lat / 12.0 * PI) + 320 * Math.sin(lat * PI / 30.0)) * 2.0 / 3.0;
            return ret;
        }
        function transformlng(lng, lat) {
            let ret = 300.0 + lng + 2.0 * lat + 0.1 * lng * lng + 0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng));
            ret += (20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0 / 3.0;
            ret += (20.0 * Math.sin(lng * PI) + 40.0 * Math.sin(lng / 3.0 * PI)) * 2.0 / 3.0;
            ret += (150.0 * Math.sin(lng / 12.0 * PI) + 300.0 * Math.sin(lng / 30.0 * PI)) * 2.0 / 3.0;
            return ret;
        }
        let dlat = transformlat(lng - 105.0, lat - 35.0);
        let dlng = transformlng(lng - 105.0, lat - 35.0);
        let radlat = lat / 180.0 * PI;
        let magic = Math.sin(radlat);
        magic = 1 - ee * magic * magic;
        let sqrtmagic = Math.sqrt(magic);
        dlat = (dlat * 180.0) / ((a * (1 - ee)) / (magic * sqrtmagic) * PI);
        dlng = (dlng * 180.0) / (a / sqrtmagic * Math.cos(radlat) * PI);
        let mglat = lat + dlat, mglng = lng + dlng;
        return [lng * 2 - mglng, lat * 2 - mglat];
    }

    // ================================================================
    // 通用
    // ================================================================

    function updateUI() {
        const selectedCount = fileItems.filter(f => f.selected).length;
        addTaskBadge.textContent = selectedCount;
        addTaskBtn.disabled = selectedCount === 0 || latInput.value.trim() === '' || lngInput.value.trim() === '';
        rangeSelectBtn.disabled = selectedCount < 2;
        startBtn.disabled = tasks.length === 0;
    }

    function showStatus(text, type) {
        statusDiv.textContent = text;
        statusDiv.className = 'status ' + type;
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    init();
})();
