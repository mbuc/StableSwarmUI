
/**
 * If true, the workflow iframe is present. If false, the tab has never been opened, or loading failed.
 */
let hasComfyLoaded = false;

let comfyButtonsArea = getRequiredElementById('comfy_workflow_buttons');

let comfyObjectData = {};

let comfyHasTriedToLoad = false;

/**
 * Tries to load the ComfyUI workflow frame.
 */
function comfyTryToLoad() {
    if (hasComfyLoaded) {
        return;
    }
    hasComfyLoaded = true;
    comfyButtonsArea.style.display = 'block';
    let container = getRequiredElementById('comfy_workflow_frameholder');
    container.innerHTML = `<iframe class="comfy_workflow_frame" id="comfy_workflow_frame" src="/ComfyBackendDirect/" onload="comfyOnLoadCallback()"></iframe>`;
}

/**
 * Returns the ComfyUI workflow frame (or errors if not present).
 */
function comfyFrame() {
    return getRequiredElementById('comfy_workflow_frame');
}

/**
 * Callback triggered when the ComfyUI workflow frame loads.
 */
function comfyOnLoadCallback() {
    if (comfyFrame().contentWindow.document.body.getElementsByClassName('comfy-failed-to-load').length == 1) {
        hasComfyLoaded = false;
        comfyButtonsArea.style.display = 'none';
        comfyFrame().remove();
        getRequiredElementById('comfy_workflow_frameholder').innerHTML = `<h2>Failed to load ComfyUI workflow editor. <button onclick="comfyTryToLoad()">Try Again?</button></h2>`;
    }
    else {
        getJsonDirect('/ComfyBackendDirect/object_info', (_, data) => {
            comfyObjectData = data;
        });
    }
}

/**
 * Callback when params refresh, to re-assign object_info.
 */
function comfyReloadObjectInfo() {
    let resolve = undefined;
    let promise = new Promise(r => { resolve = r });
    getJsonDirect('/ComfyBackendDirect/object_info', (_, data) => {
        comfyObjectData = data;
        for (let param of gen_param_types) {
            if (param.revalueGetter) {
                param.values = param.revalueGetter();
            }
        }
        resolve();
    });
    return promise;
}

/**
 * Gets the current Comfy API prompt and UI Workflow file (async) then calls a callback with the (workflow, prompt).
 */
function comfyGetPromptAndWorkflow(callback) {
    comfyFrame().contentWindow.app.graphToPrompt().then(r => callback(r.workflow, r.output));
}

/**
 * Gets the current Comfy workflow prompt (async) then calls a callback with the prompt object.
 */
function comfyGetPrompt(callback) {
    comfyFrame().contentWindow.app.graphToPrompt().then(r => callback(r.output));
}

/**
 * Builds a set of pseudo-parameters for the current Comfy workflow (async) then calls a callback with the parameter set object, the API workflow, and a list of retained default parameters, as callback(params, workflow, retained).
 */
function comfyBuildParams(callback) {
    comfyGetPromptAndWorkflow((workflow, prompt) => {
        let params = {};
        let inputPrefix = 'comfyrawworkflowinput';
        let idsUsed = [];
        function addSimpleParam(name, defVal, type, groupName, values, view_type, min, max, step, inputIdDirect, groupId, priority, visible = true, toggles = true, revalueGetter = null) {
            let inputId = inputIdDirect;
            let counter = 0;
            while (inputId in params) {
                inputId = `${inputIdDirect}${numberToLetters(counter++)}`;
            }
            params[inputId] = {
                name: name,
                default: defVal,
                id: inputId,
                type: type,
                description: `The ${name} input for ${groupName} (${type})`,
                values: values,
                view_type: view_type,
                min: min,
                max: max,
                step: step,
                visible: visible,
                toggleable: toggles,
                priority: 5,
                advanced: false,
                feature_flag: null,
                do_not_save: false,
                revalueGetter: revalueGetter,
                no_popover: true,
                group: {
                    name: groupName,
                    id: groupId,
                    open: false,
                    priority: priority,
                    advanced: groupId != 'primitives',
                    toggles: false,
                    do_not_save: false
                }
            };
        }
        let labelAlterations = {};
        let nodeStatics = {};
        let nodeIdToClean = {};
        let nodeStaticUnique = [];
        let nodeLabelPaths = {};
        let nodeIsRandomize = {};
        for (let node of workflow.nodes) {
            if (node.title) {
                labelAlterations[`${node.id}`] = node.title;
            }
            let isRandom = node.widgets_values && node.widgets_values.includes('randomize');
            if (isRandom) {
                nodeIsRandomize[`${node.id}`] = true;
            }
            if (node.type == 'PrimitiveNode' && node.title) {
                let cleanTitle = cleanParamName(node.title);
                let cleaned = inputPrefix + cleanTitle;
                let id = cleaned;
                let x = 0;
                while (nodeStaticUnique.includes(node.title)) {
                    id = `${cleaned}${numberToLetters(x++)}`;
                }
                nodeStaticUnique.push(id);
                for (let links of workflow.links) {
                    if (links[1] == node.id) {
                        nodeStatics[`${links[3]}.${links[4]}`] = id;
                        nodeIdToClean[id] = node.title;
                    }
                }
            }
        }
        for (let node of workflow.nodes) {
            if (node.inputs) {
                let x = 0;
                for (let input of node.inputs) {
                    nodeLabelPaths[`${node.id}.${input.name}`] = `${node.id}.${x++}`;
                    let link = `${node.id}`;
                    if (link in labelAlterations) {
                        labelAlterations[`${node.id}.${input.name}`] = labelAlterations[link];
                    }
                }
            }
        }
        let hasSaves = false;
        for (let nodeId of Object.keys(prompt)) {
            let node = prompt[nodeId];
            if (node.class_type == 'PreviewImage') {
                delete prompt[nodeId];
                continue;
            }
            if (node.class_type == 'SaveImage') {
                hasSaves = true;
            }
            if (node.inputs) {
                for (let inputId of Object.keys(node.inputs)) {
                    let val = node.inputs[inputId];
                    if (typeof val == 'object' && val.length == 2) {
                        if (inputId == 'negative' && val[1] == 0) {
                            labelAlterations[val[0]] = 'Negative Prompt';
                        }
                        else if (inputId == 'positive' && val[1] == 0) {
                            labelAlterations[val[0]] = 'Positive Prompt';
                        }
                    }
                }
            }
        }
        // Special case: propagate label alterations to conditioning nodes, for ReVision workflows
        let hasFixes = true;
        while (hasFixes) {
            hasFixes = false;
            for (let nodeId of Object.keys(prompt)) {
                let node = prompt[nodeId];
                if (node.class_type == 'unCLIPConditioning' && labelAlterations[nodeId]) {
                    let inputCond = node.inputs['conditioning'];
                    if (typeof inputCond == 'object' && inputCond.length == 2 && !labelAlterations[inputCond[0]]) {
                        labelAlterations[inputCond[0]] = labelAlterations[nodeId];
                        hasFixes = true;
                    }
                }
            }
        }
        if (!hasSaves) {
            showError('ComfyUI Workflow must have at least one SaveImage node!');
            document.getElementById('maintab_comfyworkfloweditor').click();
            return;
        }
        let defaultParamsRetain = ['images', 'model', 'comfyuicustomworkflow'];
        let defaultParamValue = {};
        let groups = [];
        for (let nodeId of Object.keys(prompt)) {
            let node = prompt[nodeId];
            let groupLabel = `${labelAlterations[nodeId] || node.class_type} (Node ${nodeId})`;
            let groupId = cleanParamName(labelAlterations[nodeId] || node.class_type);
            if (groups.includes(groupId)) {
                groupId = `${groupId}${numberToLetters(parseInt(nodeId))}`;
            }
            groups.push(groupId);
            let priority = 0;
            if (groupLabel.includes('Prompt')) {
                priority = -10;
            }
            else if (groupLabel.includes('EmptyLatent')) {
                priority = -7;
            }
            else if (groupLabel.includes('KSampler')) {
                priority = -5;
            }
            function injectType(id, type) {
                if (id.startsWith(inputPrefix)) {
                    id = inputPrefix + type + id.substring(inputPrefix.length);
                }
                return id;
            }
            function addParam(inputId, inputIdDirect, inputLabel, val, groupId, groupLabel, forceUniqueId) {
                let paramDataRaw;
                if (node.class_type in comfyObjectData) {
                    let possible = comfyObjectData[node.class_type].input;
                    if ('required' in possible && inputId in possible.required) {
                        paramDataRaw = possible.required[inputId];
                    }
                }
                let revalueGetter = null;
                let type, values = null, min = -9999999999, max = 9999999999, view_type = 'normal', step = 1;
                if (typeof val == 'number') {
                    let asSeed = false;
                    if (inputId == 'batch_size') {
                        node.inputs[inputId] = 1;
                        return inputIdDirect;
                    }
                    if (['seed', 'noise_seed'].includes(inputId)) {
                        type = 'integer';
                        view_type = 'seed';
                        asSeed = true;
                        if (nodeId in nodeIsRandomize) {
                            val = -1;
                        }
                    }
                    else if (['width', 'height'].includes(inputId)) {
                        type = 'integer';
                        view_type = 'pot_slider';
                        min = 128;
                        max = 8192;
                        step = 64;
                    }
                    else if (inputId == 'denoise') {
                        type = 'decimal';
                        min = 0;
                        max = 1;
                        step = 0.05;
                        view_type = 'slider';
                    }
                    else if (inputId == 'cfg') {
                        type = 'decimal';
                        min = 1;
                        max = 50;
                        step = 0.5;
                    }
                    else if (['steps', 'start_at_step', 'end_at_step'].includes(inputId)) {
                        type = 'integer';
                        min = 1;
                        max = 50;
                        step = 1;
                    }
                    else {
                        if (paramDataRaw && paramDataRaw[0] == 'INT' && paramDataRaw.length == 2) {
                            type = 'integer';
                            view_type = 'big';
                            min = paramDataRaw[1].min;
                            max = paramDataRaw[1].max;
                            step = 1;
                        }
                        else if (paramDataRaw && paramDataRaw[0] == 'FLOAT' && paramDataRaw.length == 2) {
                            type = 'decimal';
                            view_type = 'slider';
                            min = paramDataRaw[1].min;
                            max = paramDataRaw[1].max;
                            step = (max - min) * 0.01;
                        }
                        else {
                            type = 'decimal';
                        }
                    }
                    inputIdDirect = injectType(inputIdDirect, asSeed ? 'seed' : type);
                    if (forceUniqueId) {
                        let count = 0;
                        while (idsUsed.includes(inputIdDirect)) {
                            count++;
                            inputIdDirect = `${inputIdDirect}${numberToLetters(count)}`;
                        }
                    }
                    node.inputs[inputId] = "%%_COMFYFIXME_${" + inputIdDirect + (asSeed ? "+seed" : "") + ":" + val + "}_ENDFIXME_%%";
                }
                else if (typeof val == 'string') {
                    if (node.class_type == 'SaveImage' && inputId == 'filename_prefix') {
                        node.inputs[inputId] = "${prefix:}";
                        return inputIdDirect;
                    }
                    else if (node.class_type == 'CheckpointLoaderSimple' && inputId == 'ckpt_name') {
                        if (!('model' in defaultParamValue)) {
                            defaultParamValue['model'] = node.inputs[inputId];
                            node.inputs[inputId] = "${model:error_missing_model}";
                            return inputIdDirect;
                        }
                        type = 'model';
                        values = allModels;
                    }
                    else if (node.class_type == 'KSamplerAdvanced' && inputId in ['add_noise', 'return_with_leftover_noise']) {
                        // TODO: Should be a checkbox.
                        type = 'dropdown';
                        values = ['enable', 'disable'];
                    }
                    else {
                        if (paramDataRaw && paramDataRaw.length == 1 && paramDataRaw[0].length > 1) {
                            type = 'dropdown';
                            values = paramDataRaw[0];
                            revalueGetter = () => {
                                return comfyObjectData[node.class_type].input.required[inputId][0];
                            };
                        }
                        else {
                            if (node.class_type.includes('CLIP')) {
                                view_type = 'prompt';
                            }
                            type = 'text';
                        }
                    }
                    inputIdDirect = injectType(inputIdDirect, type);
                    if (forceUniqueId) {
                        let count = 0;
                        while (idsUsed.includes(inputIdDirect)) {
                            count++;
                            inputIdDirect = `${inputIdDirect}${numberToLetters(count)}`;
                        }
                    }
                    node.inputs[inputId] = "${" + inputIdDirect + ":" + val.replaceAll('${', '(').replaceAll('}', ')') + "}";
                }
                else {
                    return inputIdDirect;
                }
                if (!idsUsed.includes(inputIdDirect)) {
                    idsUsed.push(inputIdDirect);
                    addSimpleParam(inputLabel, val, type, groupLabel, values, view_type, min, max, step, inputIdDirect, groupId, priority, true, true, revalueGetter);
                }
                return inputIdDirect;
            }
            function claimOnce(classType, paramName, fieldName, numeric) {
                if (node.class_type != classType) {
                    return false;
                }
                let val = node.inputs[fieldName];
                if (typeof val == (numeric ? 'number' : 'string')) {
                    let redirId = nodeStatics[nodeLabelPaths[`${nodeId}.${fieldName}`]];
                    let useParamName = paramName;
                    let paramNameClean = cleanParamName(paramName);
                    let actualId = useParamName;
                    let result = false;
                    if (redirId) {
                        useParamName = redirId;
                        actualId = redirId;
                        let title = nodeIdToClean[redirId] || redirId.substring(inputPrefix.length);
                        let colon = title.indexOf(':');
                        if (colon > 0 && cleanParamName(title.substring(0, colon)) == 'swarmui') {
                            let reuseParam = cleanParamName(title.substring(colon + 1));
                            if (rawGenParamTypesFromServer.filter(x => x.id == reuseParam).length > 0) {
                                if (!defaultParamsRetain.includes(reuseParam)) {
                                    defaultParamsRetain.push(reuseParam);
                                    defaultParamValue[reuseParam] = val;
                                }
                                node.inputs[fieldName] = numeric ? "%%_COMFYFIXME_${" + reuseParam + ":" + val + "}_ENDFIXME_%%" : "${" + reuseParam + ":" + val.replaceAll('${', '(').replaceAll('}', ')') + "}";
                                return true;
                            }
                        }
                        actualId = addParam(fieldName, actualId, title, val, 'primitives', 'Primitives', false);
                    }
                    else if (defaultParamsRetain.includes(paramNameClean)) {
                        return false;
                    }
                    else {
                        defaultParamsRetain.push(paramNameClean);
                        defaultParamValue[paramNameClean] = val;
                        result = true;
                    }
                    node.inputs[fieldName] = numeric ? "%%_COMFYFIXME_${" + actualId + ":" + val + "}_ENDFIXME_%%" : "${" + actualId + ":" + val.replaceAll('${', '(').replaceAll('}', ')') + "}";
                    return result;
                }
                return false;
            }
            if (claimOnce('EmptyLatentImage', 'width', 'width', true) && claimOnce('EmptyLatentImage', 'height', 'height', true) && claimOnce('EmptyLatentImage', 'batchsize', 'batch_size', true)) {
                defaultParamsRetain.push('aspectratio');
                defaultParamValue['aspectratio'] = 'Custom';
                continue;
            }
            claimOnce('KSampler', 'seed', 'seed', true);
            claimOnce('KSampler', 'steps', 'steps', true);
            claimOnce('KSampler', 'comfyui_sampler', 'sampler_name', false);
            claimOnce('KSampler', 'comfyui_scheduler', 'scheduler', false);
            claimOnce('KSampler', 'cfg_scale', 'cfg', true);
            claimOnce('KSamplerAdvanced', 'seed', 'noise_seed', true);
            claimOnce('KSamplerAdvanced', 'steps', 'steps', true);
            claimOnce('KSamplerAdvanced', 'comfyui_sampler', 'sampler_name', false);
            claimOnce('KSamplerAdvanced', 'comfyui_scheduler', 'scheduler', false);
            claimOnce('KSamplerAdvanced', 'cfg_scale', 'cfg', true);
            claimOnce('LoadImage', 'initimage', 'image', false);
            if (node.class_type == 'CLIPTextEncode' && groupLabel.startsWith("Positive Prompt") && !defaultParamsRetain.includes('prompt') && typeof node.inputs.text == 'string') {
                defaultParamsRetain.push('prompt');
                defaultParamValue['prompt'] = node.inputs.text;
                node.inputs.text = "${prompt}";
                continue;
            }
            else if (node.class_type == 'CLIPTextEncode' && groupLabel.startsWith("Negative Prompt") && !defaultParamsRetain.includes('negativeprompt') && typeof node.inputs.text == 'string') {
                defaultParamsRetain.push('negativeprompt');
                defaultParamValue['negativeprompt'] = node.inputs.text;
                node.inputs.text = "${negativeprompt}";
                continue;
            }
            for (let inputId of Object.keys(node.inputs)) {
                let val = node.inputs[inputId];
                if (`${val}`.startsWith('${') || `${val}`.startsWith('%%_COMFYFIXME_${')) {
                    continue;
                }
                if (['KSampler', 'KSamplerAdvanced'].includes(node.class_type) && inputId == 'control_after_generate') {
                    continue;
                }
                let redirId = nodeStatics[nodeLabelPaths[`${nodeId}.${inputId}`]];
                if (redirId) {
                    let title = nodeIdToClean[redirId] || redirId.substring(inputPrefix.length);
                    let colon = title.indexOf(':');
                    if (colon > 0 && cleanParamName(title.substring(0, colon)) == 'swarmui') {
                        let reuseParam = cleanParamName(title.substring(colon + 1));
                        if (rawGenParamTypesFromServer.filter(x => x.id == reuseParam).length > 0) {
                            if (!defaultParamsRetain.includes(reuseParam)) {
                                defaultParamsRetain.push(reuseParam);
                                defaultParamValue[reuseParam] = val;
                            }
                            node.inputs[inputId] = typeof val != 'string' ? "%%_COMFYFIXME_${" + reuseParam + ":" + val + "}_ENDFIXME_%%" : "${" + reuseParam + ":" + val.replaceAll('${', '(').replaceAll('}', ')') + "}";
                            continue;
                        }
                    }
                    addParam(inputId, redirId, title, val, 'primitives', 'Primitives', false);
                }
                else {
                    let inputLabel = labelAlterations[`${nodeId}.${inputId}`] || inputId;
                    let inputIdDirect = cleanParamName(`${inputPrefix}${groupLabel}${inputId}${numberToLetters(parseInt(nodeId))}`);
                    addParam(inputId, inputIdDirect, inputLabel, val, groupId, groupLabel, true);
                }
            }
        }
        addSimpleParam('comfyworkflowraw', JSON.stringify(prompt), 'text', 'Comfy Workflow Raw', null, 'big', 0, 1, 1, 'comfyworkflowraw', 'comfyworkflow', 10, false, false, null);
        callback(params, prompt, defaultParamsRetain, defaultParamValue, workflow);
    });
}

/**
 * Updates the parameter list to match the currently ComfyUI workflow.
 */
function replaceParamsToComfy() {
    comfyBuildParams((params, prompt, retained, paramVal, workflow) => {
        setComfyWorkflowInput(params, retained, paramVal, true);
    });
}

function setComfyWorkflowInput(params, retained, paramVal, applyValues) {
    localStorage.setItem('last_comfy_workflow_input', JSON.stringify({params, retained, paramVal}));
    let actualParams = [];
    params['comfyworkflowraw'].extra_hidden = true;
    actualParams.push(params['comfyworkflowraw']); // must be first
    delete params['comfyworkflowraw'];
    for (let param of rawGenParamTypesFromServer.filter(p => retained.includes(p.id) || p.always_retain)) {
        actualParams.push(param);
        let val = paramVal[param.id];
        if (val) {
            // Comfy can do full 2^64 but that causes backend issues (can't have 2^64 *and* -1 as options, so...) so cap to 2^63
            if (param.type == 'integer' && param.view_type == 'seed' && val > 2**63) {
                val = -1;
            }
            if (applyValues && val !== null && val !== undefined) {
                if (param.id == 'model') {
                    forceSetDropdownValue('current_model', val);
                }
                else {
                    setCookie(`lastparam_input_${param.id}`, `${val}`, 0.5);
                }
            }
        }
    }
    let gn = (p) => p.group.id == "primitives" ? "!primitives" : p.group.id; // Bias primitives to the top
    for (let param of Object.values(params).sort((a, b) => gn(a).localeCompare(gn(b)))) {
        actualParams.push(param);
    }
    gen_param_types = actualParams;
    genInputs(true);
    let area = getRequiredElementById('main_inputs_area');
    area.innerHTML = '<button class="basic-button" onclick="comfyParamsDisable()">Disable Custom ComfyUI Workflow</button>\n' + area.innerHTML;
}

/**
 * Called to forced the parameter list back to default (instead of comfy-workflow-specific).
 */
function comfyParamsDisable() {
    localStorage.removeItem('last_comfy_workflow_input');
    gen_param_types = rawGenParamTypesFromServer;
    genInputs(true);
}

/**
 * Called when the user wants to use the workflow (via button press) to load the workflow and tab over.
 */
function comfyUseWorkflowNow() {
    replaceParamsToComfy();
    getRequiredElementById('text2imagetabbutton').click();
}

let lastComfyMessageId = 0;

function comfyNoticeMessage(message) {
    let messageId = ++lastComfyMessageId;
    let infoSlot = getRequiredElementById('comfy_notice_slot');
    infoSlot.innerText = message;
    setTimeout(() => {
        if (lastComfyMessageId == messageId) {
            infoSlot.innerText = "";
        }
    }, 2000);
}

/**
 * Called when the user wants to save the workflow (via button press).
 */
function comfySaveWorkflowNow() {
    comfyBuildParams((params, prompt_text, retained, paramVal, workflow) => {
        let name = prompt("Enter name to save workflow as:");
        if (!name.trim()) {
            return;
        }
        comfyNoticeMessage("Saving...");
        prompt_text = JSON.stringify(prompt_text).replaceAll("\"%%_COMFYFIXME_${", "${").replaceAll("}_ENDFIXME_%%\"", "}");
        genericRequest('ComfySaveWorkflow', { 'name': name, 'workflow': JSON.stringify(workflow), 'prompt': prompt_text, 'custom_params': params }, (data) => {
            comfyNoticeMessage("Saved!");
        });
    });
}

/**
 * Called when the user wants to load a workflow (via button press).
 */
function comfyLoadWorkflowNow() {
    comfyNoticeMessage("Prepping, please wait...");
    let selector = getRequiredElementById('comfy_load_modal_selector');
    selector.innerHTML = '<option></option>';
    genericRequest('ComfyListWorkflows', {}, (data) => {
        for (let workflow of data.workflows) {
            let option = document.createElement('option');
            option.innerText = workflow;
            selector.appendChild(option);
        }
        $('#comfy_workflow_load_modal').modal('show');
    });
}

/** Load button in the Load modal. */
function comfyLoadModalLoadNow() {
    let selector = getRequiredElementById('comfy_load_modal_selector');
    let selected = selector.options[selector.selectedIndex].value;
    if (!selected) {
        return;
    }
    comfyNoticeMessage("Loading...");
    genericRequest('ComfyReadWorkflow', { 'name': selected }, (data) => {
        let workflow = data.result.workflow;
        // Note: litegraph does some dumb prototype hacks so this clone forces it to work properly
        comfyFrame().contentWindow.app.loadGraphData(comfyFrame().contentWindow.LiteGraph.cloneObject(JSON.parse(workflow)));
        comfyNoticeMessage("Loaded.");
    });
    comfyHideLoadModal();
}

/** Delete button in the Load modal. */
function comfyLoadModalDelete() {
    let selector = getRequiredElementById('comfy_load_modal_selector');
    let selected = selector.options[selector.selectedIndex].value;
    if (!selected) {
        return;
    }
    if (!confirm(`Are you sure you want to delete the workflow "${selected}"?`)) {
        return;
    }
    comfyNoticeMessage("Deleting...");
    genericRequest('ComfyDeleteWorkflow', { 'name': selected }, (data) => {
        comfyNoticeMessage("Deleted.");
    });
    comfyHideLoadModal();
}

/** Cancel button in the Load modal. */
function comfyHideLoadModal() {
    $('#comfy_workflow_load_modal').modal('hide');
}

/** Button to get the buttons out of the way. */
function comfyToggleButtonsVisible() {
    let button = getRequiredElementById('comfy_buttons_closer');
    let left = getRequiredElementById('comfy_workflow_buttons_left');
    let right = getRequiredElementById('comfy_workflow_buttons_right');
    if (left.style.display == 'none') {
        left.style.display = '';
        right.style.display = '';
        button.innerHTML = '&#x2B9D;';
    }
    else {
        left.style.display = 'none';
        right.style.display = 'none';
        button.innerHTML = '&#x2B9F;';
    }
}

getRequiredElementById('maintab_comfyworkfloweditor').addEventListener('click', comfyTryToLoad);

backendsRevisedCallbacks.push(() => {
    let hasAny = Object.values(backends_loaded).filter(x => x.type.startsWith('comfyui_')
        || x.type == 'swarmswarmbackend' // TODO: Actually check if the backend has a comfy instance rather than just assuming swarmback==comfy
        ).length > 0;
    getRequiredElementById('maintab_comfyworkfloweditor').style.display = hasAny ? 'block' : 'none';
    if (hasAny && !comfyHasTriedToLoad) {
        comfyHasTriedToLoad = true;
        comfyReloadObjectInfo();
    }
});

/**
 * Prep-callback that can restore the last comfy workflow input you had.
 */
function comfyCheckPrep() {
    let lastComfyWorkflowInput = localStorage.getItem('last_comfy_workflow_input');
    if (lastComfyWorkflowInput) {
        let {params, retained, paramVal} = JSON.parse(lastComfyWorkflowInput);
        setComfyWorkflowInput(params, retained, paramVal, false);
    }
}

sessionReadyCallbacks.push(comfyCheckPrep);
