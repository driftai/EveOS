module.exports = function loadLocalizeState(ctx, runScript) {
    const prefix = 'js/modules/features/audioflix/';
    for (const name of [
        'audioflix.state.schema.js',
        'audioflix.state.groups.js',
        'audioflix.state.recovery.js',
        'audioflix.state.mirror.js',
        'audioflix.library.index.js',
        'audioflix.state.mutations.js',
        'audioflix.state.persistence.js',
        'audioflix.state.js'
    ]) runScript(ctx, prefix + name);
};
