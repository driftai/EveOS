/**
 * svgFixLogic.js
 * Core logic for identifying and fixing SVG viewBox issues.
 */

window.SvgFixingCore = window.SvgFixingCore || {};

window.SvgFixingCore.fixSvgViewBoxIssues = function (root) {
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    let fixedCount = 0;

    // Fix SVG elements with percentage viewBox values inside the selected scope.
    const allPercentageSvgs = scope.querySelectorAll('svg');
    allPercentageSvgs.forEach(svg => {
        const currentViewBox = svg.getAttribute('viewBox');
        if (currentViewBox && currentViewBox.includes('%')) {
            let fixedViewBox = '0 0 100 4';

            if (currentViewBox.includes('24')) {
                fixedViewBox = '0 0 24 24';
            } else if (currentViewBox.includes('48')) {
                fixedViewBox = '0 0 48 48';
            } else if (currentViewBox.includes('0 0 100%')) {
                fixedViewBox = '0 0 100 4';
            } else {
                fixedViewBox = currentViewBox
                    .replace(/100%/g, '100')
                    .replace(/\d+%/g, (match) => match.replace('%', ''))
                    .replace(/%/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
            }

            svg.setAttribute('viewBox', fixedViewBox);
            fixedCount++;
        }
    });

    const mdlSelectors = [
        '.mdl-progress',
        '.mdl-js-progress',
        '.mdl-progress__bar',
        '.mdl-progress__buffer',
        '.mdl-progress__primarybar',
        '.mdl-progress__secondarybar',
        '.mdl-spinner',
        '.mdl-spinner__layer',
        '[class*="mdl-progress"]',
        '[class*="progress"]'
    ];

    mdlSelectors.forEach(selector => {
        const elements = scope.querySelectorAll(selector);
        elements.forEach(element => {
            const svgs = element.querySelectorAll('svg');
            svgs.forEach(svg => {
                const viewBox = svg.getAttribute('viewBox');
                if (!viewBox || viewBox.includes('%') || viewBox === '0 0 100% 4') {
                    svg.setAttribute('viewBox', '0 0 100 4');
                    fixedCount++;
                }
            });
        });
    });

    const knownProblematicPatterns = [
        { selector: 'svg[viewBox="0 0 100% 4"]', fix: '0 0 100 4' },
        { selector: 'svg[viewBox="0 0 100% 8"]', fix: '0 0 100 8' },
        { selector: 'svg[viewBox="0 0 100% 2"]', fix: '0 0 100 2' },
        { selector: 'svg[viewBox="0 0 100% 1"]', fix: '0 0 100 1' },
        { selector: 'svg[viewBox*="100%"]', fix: '0 0 100 4' },
        { selector: 'svg[viewBox*="50%"]', fix: '0 0 50 4' },
        { selector: 'svg[viewBox*="%"]', fix: '0 0 100 4' }
    ];

    knownProblematicPatterns.forEach(({ selector, fix }) => {
        try {
            const problematicSvgs = scope.querySelectorAll(selector);
            problematicSvgs.forEach(svg => {
                svg.setAttribute('viewBox', fix);
                fixedCount++;
            });
        } catch (e) {
            // Ignore selector errors in older browser builds.
        }
    });

    if (fixedCount > 0) {
        console.log(`SVG viewBox fixes completed in Gemini scope: ${fixedCount} SVGs fixed`);
    }
    return fixedCount;
};

console.log('svgFixLogic.js loaded.');
