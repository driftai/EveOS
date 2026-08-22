export const EARTH_FRAGMENT_SHADER = `
  uniform sampler2D uMap;
  uniform vec3 uLightDirection;
  uniform float uHexDensity;
  uniform float uHexStrength;
  uniform float uHexBorderStrength;
  uniform float uHexEdgeWidth;
  uniform float uHexCohesion;
  uniform float uHexCoastSnap;
  uniform float uHexEqualArea;
  uniform float uCartoon;
  uniform float uLandTintStrength;
  uniform float uSaturation;
  uniform float uOceanShine;
  uniform float uFullLight;
  uniform float uGridVisible;
  uniform float uGridOpacity;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying float vProjectionBlend;

  const float PI = 3.14159265359;
  const float SQRT3 = 1.73205080757;
  const float INV_SQRT3 = 0.57735026919;

  vec3 cubeRound(vec3 cube) {
    vec3 rounded = floor(cube + 0.5);
    vec3 difference = abs(rounded - cube);
    if (difference.x > difference.y && difference.x > difference.z) {
      rounded.x = -rounded.y - rounded.z;
    } else if (difference.y > difference.z) {
      rounded.y = -rounded.x - rounded.z;
    } else {
      rounded.z = -rounded.x - rounded.y;
    }
    return rounded;
  }

  vec2 nearestPointyHexCenter(vec2 point) {
    float q = INV_SQRT3 * point.x - point.y / 3.0;
    float r = point.y * 2.0 / 3.0;
    vec3 cube = cubeRound(vec3(q, -q - r, r));
    return vec2(SQRT3 * (cube.x + cube.z * 0.5), 1.5 * cube.z);
  }

  float signedHexDistance(vec2 point) {
    const vec3 k = vec3(-0.8660254, 0.5, 0.5773503);
    point = abs(point);
    point -= 2.0 * min(dot(k.xy, point), 0.0) * k.xy;
    point -= vec2(clamp(point.x, -k.z, k.z), 1.0);
    return length(point) * sign(point.y);
  }

  float hash12(vec2 point) {
    vec3 p3 = fract(vec3(point.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  vec2 toHexGridUv(vec2 uv) {
    float latitude = (uv.y - 0.5) * PI;
    float equalAreaY = sin(latitude) * 0.5 + 0.5;
    return vec2(uv.x, mix(uv.y, equalAreaY, uHexEqualArea));
  }

  float fromHexGridY(float gridY) {
    float equalAreaY = asin(clamp(gridY * 2.0 - 1.0, -1.0, 1.0)) / PI + 0.5;
    return mix(gridY, equalAreaY, uHexEqualArea);
  }

  void resolveHexCell(vec2 uv, out vec2 centerUv, out vec2 localHex, out vec2 cellId) {
    vec2 gridUv = toHexGridUv(uv);
    vec2 point = (gridUv - 0.5) * vec2(uHexDensity * 2.0, uHexDensity);
    vec2 center = nearestPointyHexCenter(point);
    localHex = point - center;
    cellId = center;
    vec2 centerGridUv = center / vec2(uHexDensity * 2.0, uHexDensity) + 0.5;
    centerUv = vec2(fract(centerGridUv.x), clamp(fromHexGridY(centerGridUv.y), 0.001, 0.999));
  }

  vec3 adjustSaturation(vec3 color, float amount) {
    float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
    return mix(vec3(luminance), color, amount);
  }

  float oceanConfidence(vec3 color) {
    float brightness = dot(color, vec3(0.299, 0.587, 0.114));
    float strongestLand = max(color.r, color.g);
    float blueBias = color.b - strongestLand;
    float blueRatio = color.b / max(strongestLand, 0.0001);
    float darkOcean = (1.0 - smoothstep(0.008, 0.055, brightness))
      * smoothstep(1.25, 2.20, blueRatio);
    float visibleOcean = smoothstep(0.001, 0.045, blueBias)
      * smoothstep(1.05, 1.65, blueRatio);
    float warmLand = smoothstep(0.020, 0.180, color.r + color.g - color.b * 1.10);
    float greenLand = smoothstep(0.008, 0.120, color.g - color.b * 0.62);
    return clamp(max(darkOcean, visibleOcean) * (1.0 - max(warmLand, greenLand) * 0.96), 0.0, 1.0);
  }

  vec3 stylizeLand(vec3 color) {
    float warmth = smoothstep(0.08, 0.38, color.r - color.b);
    float dryness = smoothstep(0.08, 0.36, color.r - color.g * 0.94);
    float brightness = dot(color, vec3(0.333333));
    float rocky = smoothstep(
      0.16,
      0.42,
      abs(color.r - color.g) + abs(color.g - color.b)
    );
    float snow = smoothstep(0.70, 0.92, brightness)
      * smoothstep(0.38, 0.75, color.b);

    // A quieter atlas palette: darker vegetation, more neutral soil, and
    // substantially less fluorescent green than the earlier biome pass.
    vec3 vegetation = vec3(0.16, 0.36, 0.15);
    vec3 grassland = vec3(0.44, 0.42, 0.22);
    vec3 dryland = vec3(0.68, 0.54, 0.32);
    vec3 stone = vec3(0.43, 0.35, 0.28);
    vec3 snowColor = vec3(0.94, 0.94, 0.92);

    vec3 biome = mix(vegetation, grassland, dryness);
    biome = mix(biome, dryland, warmth * 0.72);
    biome = mix(biome, stone, rocky * 0.36);
    biome = mix(biome, snowColor, snow);

    return mix(color, biome, clamp(uLandTintStrength, 0.0, 1.0));
  }

  vec3 stylizeOcean(vec3 color) {
    float shallow = smoothstep(0.08, 0.34, color.g + color.r * 0.30);
    vec3 target = mix(vec3(0.025, 0.16, 0.48), vec3(0.075, 0.34, 0.74), shallow);
    return mix(color, target, clamp(uCartoon, 0.0, 1.0));
  }

  vec3 polarRingAverage(float uvY) {
    float stableY = mix(uvY, uvY > 0.5 ? 0.985 : 0.015, 0.72);
    vec3 average = texture2D(uMap, vec2(0.0625, stableY)).rgb;
    average += texture2D(uMap, vec2(0.1875, stableY)).rgb;
    average += texture2D(uMap, vec2(0.3125, stableY)).rgb;
    average += texture2D(uMap, vec2(0.4375, stableY)).rgb;
    average += texture2D(uMap, vec2(0.5625, stableY)).rgb;
    average += texture2D(uMap, vec2(0.6875, stableY)).rgb;
    average += texture2D(uMap, vec2(0.8125, stableY)).rgb;
    average += texture2D(uMap, vec2(0.9375, stableY)).rgb;
    return average * 0.125;
  }

  float periodicLine(float value, float divisions, float width) {
    float position = fract(value * divisions);
    float distanceToLine = min(position, 1.0 - position);
    float antiAlias = fwidth(value * divisions);
    return 1.0 - smoothstep(width, width + antiAlias * 1.6, distanceToLine);
  }

  void main() {
    vec2 centerUv;
    vec2 localHex;
    vec2 cellId;
    resolveHexCell(vUv, centerUv, localHex, cellId);

    float latitude = (centerUv.y - 0.5) * PI;
    float latitudeScale = max(cos(latitude), 0.22);
    vec2 stepUv = vec2(
      0.28 / max(uHexDensity * 2.0 * latitudeScale, 1.0),
      0.28 / max(uHexDensity * latitudeScale, 1.0)
    );

    vec3 c0 = texture2D(uMap, centerUv).rgb;
    vec3 c1 = texture2D(uMap, centerUv + vec2(stepUv.x, 0.0)).rgb;
    vec3 c2 = texture2D(uMap, centerUv - vec2(stepUv.x, 0.0)).rgb;
    vec3 c3 = texture2D(uMap, centerUv + vec2(stepUv.x * 0.5, stepUv.y)).rgb;
    vec3 c4 = texture2D(uMap, centerUv + vec2(-stepUv.x * 0.5, stepUv.y)).rgb;
    vec3 c5 = texture2D(uMap, centerUv + vec2(stepUv.x * 0.5, -stepUv.y)).rgb;
    vec3 c6 = texture2D(uMap, centerUv + vec2(-stepUv.x * 0.5, -stepUv.y)).rgb;

    float o0 = oceanConfidence(c0);
    float o1 = oceanConfidence(c1);
    float o2 = oceanConfidence(c2);
    float o3 = oceanConfidence(c3);
    float o4 = oceanConfidence(c4);
    float o5 = oceanConfidence(c5);
    float o6 = oceanConfidence(c6);

    const float centerWeight = 0.28;
    const float ringWeight = 0.12;
    vec3 average = c0 * centerWeight + (c1 + c2 + c3 + c4 + c5 + c6) * ringWeight;
    float oceanVote = o0 * centerWeight + (o1 + o2 + o3 + o4 + o5 + o6) * ringWeight;

    vec3 landSum = c0 * (1.0 - o0) * centerWeight;
    landSum += c1 * (1.0 - o1) * ringWeight;
    landSum += c2 * (1.0 - o2) * ringWeight;
    landSum += c3 * (1.0 - o3) * ringWeight;
    landSum += c4 * (1.0 - o4) * ringWeight;
    landSum += c5 * (1.0 - o5) * ringWeight;
    landSum += c6 * (1.0 - o6) * ringWeight;
    float landWeight = (1.0 - o0) * centerWeight
      + ((1.0 - o1) + (1.0 - o2) + (1.0 - o3) + (1.0 - o4) + (1.0 - o5) + (1.0 - o6)) * ringWeight;

    vec3 oceanSum = c0 * o0 * centerWeight;
    oceanSum += c1 * o1 * ringWeight;
    oceanSum += c2 * o2 * ringWeight;
    oceanSum += c3 * o3 * ringWeight;
    oceanSum += c4 * o4 * ringWeight;
    oceanSum += c5 * o5 * ringWeight;
    oceanSum += c6 * o6 * ringWeight;
    float oceanWeight = o0 * centerWeight + (o1 + o2 + o3 + o4 + o5 + o6) * ringWeight;

    vec3 landAverage = landSum / max(landWeight, 0.001);
    vec3 oceanAverage = oceanSum / max(oceanWeight, 0.001);
    vec3 cohesiveAverage = mix(c0, average, uHexCohesion);
    landAverage = mix(cohesiveAverage, landAverage, clamp(landWeight * 1.6, 0.0, 1.0));
    oceanAverage = mix(cohesiveAverage, oceanAverage, clamp(oceanWeight * 1.6, 0.0, 1.0));

    float softCategory = smoothstep(0.34, 0.66, oceanVote);
    float hardCategory = step(0.5, oceanVote);
    float tileOcean = mix(softCategory, hardCategory, uHexCoastSnap);

    float poleLatitude = abs(sin((vUv.y - 0.5) * PI));
    float globePoleCap = smoothstep(0.955, 0.998, poleLatitude)
      * (1.0 - vProjectionBlend);
    float effectiveHexStrength = uHexStrength * (1.0 - globePoleCap);

    vec3 sourceColor = texture2D(uMap, vUv).rgb;
    if (globePoleCap > 0.001) {
      sourceColor = mix(sourceColor, polarRingAverage(vUv.y), globePoleCap);
    }
    float sourceOcean = oceanConfidence(sourceColor);
    float oceanMask = mix(sourceOcean, tileOcean, effectiveHexStrength);

    vec3 tileColor = mix(stylizeLand(landAverage), stylizeOcean(oceanAverage), tileOcean);
    float variationAmount = mix(0.0, 0.045, uCartoon);
    float tileVariation = mix(1.0 - variationAmount, 1.0 + variationAmount, hash12(cellId));
    tileColor *= tileVariation;

    vec3 sourceStyled = mix(stylizeLand(sourceColor), stylizeOcean(sourceColor), sourceOcean);
    vec3 base = mix(sourceStyled, tileColor, effectiveHexStrength);
    base = adjustSaturation(base, uSaturation);

    float distanceToEdge = abs(signedHexDistance(localHex));
    float edgeWidth = clamp(uHexEdgeWidth, 0.018, 0.22);
    float edgeAA = max(fwidth(distanceToEdge) * 1.8, 0.002);
    float border = 1.0 - smoothstep(edgeWidth, edgeWidth + edgeAA, distanceToEdge);
    vec3 borderColor = mix(vec3(0.18, 0.115, 0.065), vec3(0.008, 0.050, 0.145), oceanMask);
    base = mix(
      base,
      borderColor,
      border * uHexBorderStrength * effectiveHexStrength * 0.90
    );

    float lonLine = periodicLine(vUv.x, 24.0, 0.018);
    float latLine = periodicLine(vUv.y, 12.0, 0.018);
    float equator = 1.0 - smoothstep(0.004, 0.004 + fwidth(vUv.y) * 2.0, abs(vUv.y - 0.5));
    float grid = max(max(lonLine, latLine), equator * 0.72);
    vec3 gridColor = mix(vec3(0.80, 0.89, 1.0), vec3(0.16, 0.23, 0.34), oceanMask * 0.35);
    base = mix(base, gridColor, grid * uGridVisible * uGridOpacity);

    vec3 normal = normalize(vWorldNormal);
    vec3 lightDirection = normalize(uLightDirection);
    float diffuse = max(dot(normal, lightDirection), 0.0);
    float smoothLighting = mix(0.26, 1.0, diffuse);
    float toonLighting = floor(smoothLighting * 4.0 + 0.25) / 4.0;
    float lighting = mix(smoothLighting, toonLighting, uCartoon * 0.92);
    float finalLighting = mix(lighting, 1.0, uFullLight);

    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    vec3 halfDirection = normalize(lightDirection + viewDirection);
    float specular = pow(max(dot(normal, halfDirection), 0.0), 30.0);
    vec3 highlight = vec3(0.14, 0.39, 0.72) * specular * oceanMask
      * uOceanShine * mix(0.84, 0.30, uFullLight);

    vec3 color = base * finalLighting + highlight;
    color = mix(color, color * vec3(1.045, 1.028, 0.99), uCartoon * 0.18);
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;
