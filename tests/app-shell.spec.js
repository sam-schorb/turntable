import { expect, test } from "@playwright/test";

async function installFakePlaybackAudio(page) {
  await page.addInitScript(() => {
    const audioDebug = {
      contextsCreated: 0,
      modules: [],
      messages: []
    };

    class PhaseEightAudioContext {
      constructor() {
        audioDebug.contextsCreated += 1;
        this.destination = { type: "destination" };
        this.state = "running";
        this.audioWorklet = {
          async addModule(url) {
            audioDebug.modules.push(url);
          }
        };
      }

      resume() {
        this.state = "running";
        return Promise.resolve();
      }

      createGain() {
        return {
          gain: { value: 1 },
          connect() {}
        };
      }
    }

    class PhaseEightAudioWorkletNode {
      constructor(context, processorName, options) {
        this.context = context;
        this.processorName = processorName;
        this.options = options;
        this.port = {
          onmessage: null,
          postMessage(message) {
            audioDebug.messages.push(message);
          }
        };
        audioDebug.node = {
          processorName,
          options
        };
      }

      connect() {}
    }

    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: PhaseEightAudioContext
    });
    Object.defineProperty(window, "AudioWorkletNode", {
      configurable: true,
      value: PhaseEightAudioWorkletNode
    });
    Object.defineProperty(window, "__phaseEightAudioDebug", {
      configurable: true,
      value: audioDebug
    });
  });
}

async function sampleCanvasLayerPixel(page, testId, clientX, clientY) {
  return page.getByTestId(testId).evaluate(
    (canvas, point) => {
      const rect = canvas.getBoundingClientRect();
      const x = Math.floor(
        ((point.clientX - rect.left) / rect.width) * canvas.width
      );
      const y = Math.floor(
        ((point.clientY - rect.top) / rect.height) * canvas.height
      );

      return Array.from(canvas.getContext("2d").getImageData(x, y, 1, 1).data);
    },
    { clientX, clientY }
  );
}

async function sampleCanvasPixel(page, clientX, clientY) {
  return sampleCanvasLayerPixel(page, "turntable-canvas", clientX, clientY);
}

async function countCanvasPaintComponents(page) {
  return page.getByTestId("turntable-canvas").evaluate((canvas) => {
    const context = canvas.getContext("2d");
    const { data, width, height } = context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height
    );
    const occupied = new Uint8Array(width * height);
    const visited = new Uint8Array(width * height);
    const componentSizes = [];

    for (let index = 0; index < width * height; index += 1) {
      const red = data[index * 4];
      const green = data[index * 4 + 1];
      const blue = data[index * 4 + 2];
      const alpha = data[index * 4 + 3];
      const saturation = Math.max(red, green, blue) - Math.min(red, green, blue);

      if (alpha > 12 && saturation > 24) {
        occupied[index] = 1;
      }
    }

    for (let startIndex = 0; startIndex < occupied.length; startIndex += 1) {
      if (!occupied[startIndex] || visited[startIndex]) {
        continue;
      }

      const queue = [startIndex];
      let componentSize = 0;

      visited[startIndex] = 1;

      while (queue.length > 0) {
        const index = queue.pop();
        const x = index % width;
        const y = Math.floor(index / width);

        componentSize += 1;

        for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
          for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
            if (xOffset === 0 && yOffset === 0) {
              continue;
            }

            const nextX = x + xOffset;
            const nextY = y + yOffset;

            if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) {
              continue;
            }

            const nextIndex = nextY * width + nextX;

            if (!occupied[nextIndex] || visited[nextIndex]) {
              continue;
            }

            visited[nextIndex] = 1;
            queue.push(nextIndex);
          }
        }
      }

      componentSizes.push(componentSize);
    }

    componentSizes.sort((first, second) => second - first);

    return {
      componentCount: componentSizes.length,
      largestComponentSize: componentSizes[0] || 0,
      paintedPixelCount: componentSizes.reduce((total, size) => total + size, 0)
    };
  });
}

async function dispatchPointer(canvas, type, point, pointerId = 1, pointerType = "mouse") {
  await canvas.evaluate(
    (element, detail) => {
      element.dispatchEvent(
        new PointerEvent(detail.type, {
          pointerId: detail.pointerId,
          pointerType: detail.pointerType,
          isPrimary: true,
          clientX: detail.x,
          clientY: detail.y,
          button: 0,
          buttons:
            detail.type === "pointerup" || detail.type === "pointercancel"
              ? 0
              : 1,
          bubbles: true,
          cancelable: true
        })
      );
    },
    {
      type,
      pointerId,
      pointerType,
      x: point.x,
      y: point.y
    }
  );
}

async function getCanvasPoint(canvas, xRatio, yRatio) {
  const box = await canvas.boundingBox();

  return {
    x: box.x + box.width * xRatio,
    y: box.y + box.height * yRatio
  };
}

async function clearSavedSampleStorage(page) {
  await page.evaluate(() =>
    new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        resolve();
        return;
      }

      const request = window.indexedDB.deleteDatabase(
        "optical-sample-turntable"
      );

      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(request.error || new Error("Could not clear sample storage."));
      request.onblocked = () => resolve();
    })
  );
}

function colourDistance(first, second) {
  return Math.hypot(
    first[0] - second[0],
    first[1] - second[1],
    first[2] - second[2],
    first[3] - second[3]
  );
}

async function readTransportPhase(page) {
  return Number(
    await page.getByTestId("turntable-canvas").getAttribute("data-transport-phase")
  );
}

async function readCenterPlayButtonState(page) {
  return page.evaluate(() => {
    const playButton = document.querySelector('[data-testid="transport-play"]');
    const iconShell = document.querySelector(
      '[data-testid="transport-play-icon-shell"]'
    );

    return {
      canvasPhaseTurns: Number(
        document
          .querySelector('[data-testid="turntable-canvas"]')
          .getAttribute("data-transport-phase")
      ),
      phaseTurns: Number(playButton.getAttribute("data-phase-turns")),
      rotationDegrees: Number(playButton.getAttribute("data-rotation-degrees")),
      transform: iconShell.style.transform
    };
  });
}

async function clearPaintSelectionWithCanvasBackground(page) {
  const canvas = page.getByTestId("turntable-canvas");
  const backgroundPoint = await getCanvasPoint(canvas, 0.03, 0.03);

  await page.mouse.click(backgroundPoint.x, backgroundPoint.y);
  await expect(page.getByTestId("paint-controls")).toHaveAttribute(
    "data-paint-tool",
    "none"
  );
  await expect(page.getByTestId("paint-controls")).toHaveAttribute(
    "data-selected-colour-index",
    "none"
  );
}

test("renders the product turntable without debug chrome or playback startup", async ({ page }) => {
  const consoleErrors = [];
  const pageErrors = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.addInitScript(() => {
    let audioContextCreated = 0;

    class PhaseEightAudioContext {
      constructor() {
        audioContextCreated += 1;
        throw new Error("Playback AudioContext must not be created on load.");
      }
    }

    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: PhaseEightAudioContext
    });
    Object.defineProperty(window, "__phaseEightAudioContextCreated", {
      configurable: true,
      get() {
        return audioContextCreated;
      }
    });
  });

  await page.goto("/");

  await expect(page.getByTestId("app-shell")).toBeVisible();
  expect(
    await page.getByTestId("app-shell").evaluate(async (element) => {
      await document.fonts.ready;
      const playButton = element.querySelector('[data-testid="transport-play"]');
      const playIcon = element.querySelector('[data-testid="transport-play-icon"]');
      const pauseIcon = element.querySelector('[data-testid="transport-pause-icon"]');
      const playIconShell = element.querySelector(
        '[data-testid="transport-play-icon-shell"]'
      );
      const firstSample = element.querySelector('[data-testid="paint-colour-1"]');
      const firstSampleName = element.querySelector('[data-testid="sample-name-0"]');
      const firstSampleChip = firstSample.closest(".sample-chip");
      const firstSampleAction = firstSample.closest(".sample-chip__action");
      const secondSample = element.querySelector('[data-testid="paint-colour-2"]');
      const finalSampleAction = element.querySelector(
        '[data-testid="sample-slot-5"] .sample-chip__action'
      );
      const firstReplace = element.querySelector(
        '[data-testid="sample-upload-label-0"]'
      );
      const firstReplaceIcon = firstReplace.querySelector(
        ".sample-chip__upload-icon"
      );
      const firstReplaceMark = firstReplaceIcon.querySelector(
        ".sample-chip__upload-mark"
      );
      const eraserButton = element.querySelector('[data-testid="eraser-tool"]');
      const clearButton = element.querySelector('[data-testid="clear-paint"]');
      const eraserIcon = element.querySelector('[data-testid="eraser-tool-icon"]');
      const clearIcon = element.querySelector('[data-testid="clear-tool-icon"]');
      const speedLabel = element.querySelector(".speed-control__header");
      const readPrimaryFont = (node) =>
        getComputedStyle(node).fontFamily.split(",")[0].trim().replaceAll('"', "");

      return {
        rootFontUsesNunito:
          readPrimaryFont(document.documentElement) === "Nunito",
        rootFontScaledUp:
          Number.parseFloat(getComputedStyle(document.documentElement).fontSize) >=
          20.7,
        rootFontWeight: getComputedStyle(document.documentElement).fontWeight,
        appFontUsesNunito: readPrimaryFont(element) === "Nunito",
        appTextColour: getComputedStyle(element).color,
        playButtonColour: getComputedStyle(playButton).color,
        playButtonBorder: getComputedStyle(playButton).borderColor,
        playButtonBorderWidth: getComputedStyle(playButton).borderTopWidth,
        playButtonBackground: getComputedStyle(playButton).backgroundColor,
        playIconAtLeastTwicePreviousSize:
          playIcon.getBoundingClientRect().width /
            playButton.getBoundingClientRect().width >=
          0.74,
        playButtonText: playButton.textContent,
        playButtonAriaLabel: playButton.getAttribute("aria-label"),
        playButtonInTurntableVisual: Boolean(
          playButton.closest('[data-testid="turntable-visual"]')
        ),
        playButtonInTransportControls: Boolean(
          playButton.closest('[data-testid="transport-controls"]')
        ),
        playButtonBorderRadius: getComputedStyle(playButton).borderTopLeftRadius,
        playButtonTapHighlight: getComputedStyle(playButton).getPropertyValue(
          "-webkit-tap-highlight-color"
        ),
        playButtonTouchAction: getComputedStyle(playButton).touchAction,
        playIconShellTransform: getComputedStyle(playIconShell).transform,
        playIconDisplay: getComputedStyle(playIcon).display,
        pauseIconDisplay: getComputedStyle(pauseIcon).display,
        sampleButtonColour: getComputedStyle(firstSample).color,
        sampleButtonBorder: getComputedStyle(firstSample).borderColor,
        sampleButtonBorderTopWidth: getComputedStyle(firstSample).borderTopWidth,
        sampleButtonBoxShadow: getComputedStyle(firstSample).boxShadow,
        sampleButtonBackground: getComputedStyle(firstSample).backgroundColor,
        sampleActionLineBackgroundSize:
          getComputedStyle(firstSampleAction, "::after").backgroundSize,
        finalSampleActionLineBackgroundSize:
          getComputedStyle(finalSampleAction, "::after").backgroundSize,
        secondSampleStripe:
          getComputedStyle(secondSample, "::after").backgroundColor,
        selectedSampleClass: firstSampleChip.classList.contains("is-selected"),
        selectedSampleTextColour: getComputedStyle(firstSampleName).color,
        selectedSampleRingContent:
          getComputedStyle(firstSampleAction, "::before").content,
        selectedSampleRingWidth:
          getComputedStyle(firstSampleAction, "::before").borderTopWidth,
        replaceSegmentColour: getComputedStyle(firstReplace).color,
        replaceSegmentBorder: getComputedStyle(firstReplace).borderColor,
        replaceSegmentBorderTopWidth: getComputedStyle(firstReplace)
          .borderTopWidth,
        replaceSegmentBackground: getComputedStyle(firstReplace).backgroundColor,
        replaceArrowIsSvg: firstReplaceIcon.tagName.toLowerCase() === "svg",
        replaceArrowPoints: firstReplaceMark.getAttribute("points"),
        replaceArrowStrokeWidth: getComputedStyle(firstReplaceIcon).strokeWidth,
        replaceArrowStrokeLineCap: getComputedStyle(firstReplaceIcon).strokeLinecap,
        replaceArrowStrokeLineJoin:
          getComputedStyle(firstReplaceIcon).strokeLinejoin,
        replaceArrowVectorEffect:
          getComputedStyle(firstReplaceMark).vectorEffect,
        eraserButtonColour: getComputedStyle(eraserButton).color,
        eraserButtonBorder: getComputedStyle(eraserButton).borderColor,
        eraserButtonBackground: getComputedStyle(eraserButton).backgroundColor,
        eraserIconDisplay: getComputedStyle(eraserIcon).display,
        clearButtonColour: getComputedStyle(clearButton).color,
        clearButtonBorder: getComputedStyle(clearButton).borderColor,
        clearButtonBackground: getComputedStyle(clearButton).backgroundColor,
        clearIconDisplay: getComputedStyle(clearIcon).display,
        speedLabelColour: getComputedStyle(speedLabel).color,
        playButtonWeight: getComputedStyle(playButton).fontWeight,
        nunitoLightLoaded: document.fonts.check("300 16px 'Nunito'")
      };
    })
  ).toEqual({
    rootFontUsesNunito: true,
    rootFontScaledUp: true,
    rootFontWeight: "300",
    appFontUsesNunito: true,
    appTextColour: "rgb(0, 0, 0)",
    playButtonColour: "rgb(255, 255, 255)",
    playButtonBorder: "rgb(0, 0, 0)",
    playButtonBorderWidth: "1px",
    playButtonBackground: "rgb(128, 0, 255)",
    playIconAtLeastTwicePreviousSize: true,
    playButtonText: "",
    playButtonAriaLabel: "Play",
    playButtonInTurntableVisual: true,
    playButtonInTransportControls: false,
    playButtonBorderRadius: "50%",
    playButtonTapHighlight: "rgba(0, 0, 0, 0)",
    playButtonTouchAction: "manipulation",
    playIconShellTransform: "matrix(1, 0, 0, 1, 0, 0)",
    playIconDisplay: "block",
    pauseIconDisplay: "none",
    sampleButtonColour: "rgb(255, 230, 204)",
    sampleButtonBorder: "rgb(255, 230, 204)",
    sampleButtonBorderTopWidth: "0px",
    sampleButtonBoxShadow: "none",
    sampleButtonBackground: "rgb(255, 128, 0)",
    sampleActionLineBackgroundSize: "100% 2.55px",
    finalSampleActionLineBackgroundSize: "100% 2.55px, 100% 2.55px",
    secondSampleStripe: "rgb(255, 90, 0)",
    selectedSampleClass: true,
    selectedSampleTextColour: "rgb(255, 0, 0)",
    selectedSampleRingContent: "none",
    selectedSampleRingWidth: "0px",
    replaceSegmentColour: "rgb(255, 230, 204)",
    replaceSegmentBorder: "rgb(255, 230, 204)",
    replaceSegmentBorderTopWidth: "0px",
    replaceSegmentBackground: "rgb(255, 128, 0)",
    replaceArrowIsSvg: true,
    replaceArrowPoints: "4 2 8 6 4 10",
    replaceArrowStrokeWidth: "2.55px",
    replaceArrowStrokeLineCap: "round",
    replaceArrowStrokeLineJoin: "round",
    replaceArrowVectorEffect: "non-scaling-stroke",
    eraserButtonColour: "rgb(0, 0, 0)",
    eraserButtonBorder: "rgb(0, 0, 0)",
    eraserButtonBackground: "rgb(0, 255, 128)",
    eraserIconDisplay: "none",
    clearButtonColour: "rgb(0, 0, 0)",
    clearButtonBorder: "rgb(0, 0, 0)",
    clearButtonBackground: "rgb(128, 0, 255)",
    clearIconDisplay: "none",
    speedLabelColour: "rgb(255, 230, 204)",
    playButtonWeight: "300",
    nunitoLightLoaded: true
  });
  await page.getByTestId("transport-play").hover();
  expect(
    await page.getByTestId("transport-play").evaluate((button) => {
      const style = getComputedStyle(button);

      return {
        background: style.backgroundColor,
        usesLighterPlayButtonBackground:
          style.backgroundColor === "rgb(166, 77, 255)",
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth
      };
    })
  ).toEqual({
    background: "rgb(166, 77, 255)",
    usesLighterPlayButtonBackground: true,
    outlineStyle: "none",
    outlineWidth: "0px"
  });
  await page.getByTestId("transport-play").focus();
  expect(
    await page.getByTestId("transport-play").evaluate((button) => {
      const style = getComputedStyle(button);

      return {
        boxShadow: style.boxShadow,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth
      };
    })
  ).toEqual({
    boxShadow: "none",
    outlineStyle: "none",
    outlineWidth: "0px"
  });
  await page.getByTestId("clear-paint").hover();
  await expect(page.getByTestId("clear-paint")).toHaveCSS(
    "background-color",
    "rgb(166, 77, 255)"
  );
  await page.getByTestId("eraser-tool").hover();
  await expect(page.getByTestId("eraser-tool")).toHaveCSS(
    "background-color",
    "rgb(77, 255, 166)"
  );
  await expect(page.getByTestId("turntable-surface")).toBeVisible();
  await expect(page.getByTestId("turntable-visual")).toBeVisible();
  await expect(page.getByTestId("turntable-vector-base")).toBeVisible();
  await expect(page.getByTestId("turntable-vector-chrome")).toBeVisible();
  await expect(page.getByTestId("turntable-canvas")).toBeVisible();
  await expect(page.getByTestId("turntable-highlight-canvas")).toHaveCount(0);
  await expect(page.getByTestId("paint-controls")).toBeVisible();
  await expect(page.getByTestId("transport-controls")).toBeVisible();
  await expect(page.getByTestId("paint-swatches").locator(".paint-swatch")).toHaveCount(6);
  await expect(page.getByTestId("sample-name-0")).toHaveText("Kick");
  await expect(page.getByTestId("sample-name-5")).toHaveText("Bloom");
  await expect(page.getByText("Samples")).toHaveCount(0);
  await expect(page.getByTestId("global-loop-control")).toHaveCount(0);
  await expect(page.getByTestId("global-loop")).toHaveCount(0);
  await expect(page.getByTestId("sample-loop-0")).toHaveCount(0);
  await expect(page.getByTestId("sample-upload-label-0")).toHaveAttribute(
    "aria-label",
    "Replace Kick sample"
  );
  await expect(
    page
      .getByTestId("sample-upload-label-0")
      .locator(".sample-chip__upload-icon")
  ).toHaveCount(1);
  expect(
    await page.getByTestId("sample-upload-label-0").evaluate((element) =>
      Math.round(element.getBoundingClientRect().width)
    )
  ).toBe(38);
  expect(
    await page.getByTestId("paint-colour-1").evaluate((element) =>
      getComputedStyle(element, "::after").width
    )
  ).toBe("15px");
  const swatchBeforeHover = await page
    .getByTestId("paint-colour-1")
    .evaluate((element) => getComputedStyle(element, "::after").backgroundColor);
  const sampleBackgroundBeforeHover = await page
    .getByTestId("paint-colour-1")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  const uploadBackgroundBeforeSampleHover = await page
    .getByTestId("sample-upload-label-0")
    .evaluate((element) => getComputedStyle(element).backgroundColor);

  await page.getByTestId("paint-colour-1").hover();

  const swatchAfterHover = await page
    .getByTestId("paint-colour-1")
    .evaluate((element) => getComputedStyle(element, "::after").backgroundColor);
  const sampleBackgroundAfterHover = await page
    .getByTestId("paint-colour-1")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  const uploadBackgroundAfterSampleHover = await page
    .getByTestId("sample-upload-label-0")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  const colourChannelTotal = (rgb) =>
    (rgb.match(/\d+(?:\.\d+)?/g) || [])
      .slice(0, 3)
      .map((value) => {
        const channel = Number(value);

        return rgb.startsWith("color(") ? channel * 255 : channel;
      })
      .reduce((total, channel) => total + channel, 0);

  expect(swatchAfterHover).not.toBe(swatchBeforeHover);
  expect(colourChannelTotal(swatchAfterHover)).toBeGreaterThan(
    colourChannelTotal(swatchBeforeHover)
  );
  expect(sampleBackgroundBeforeHover).toBe("rgb(255, 128, 0)");
  expect(sampleBackgroundAfterHover).toBe("rgb(255, 166, 77)");
  expect(uploadBackgroundAfterSampleHover).toBe(uploadBackgroundBeforeSampleHover);
  expect(uploadBackgroundAfterSampleHover).toBe("rgb(255, 128, 0)");
  expect(
    await page.getByTestId("paint-colour-1").evaluate((button) => {
      const buttonRect = button.getBoundingClientRect();
      const label = button.querySelector(".sample-chip__name");
      label.textContent = "A very long sample name that should truncate";
      const labelRect = label.getBoundingClientRect();
      const labelStyle = getComputedStyle(label);

      return {
        labelLeftAligned: labelRect.left - buttonRect.left >= 18,
        labelInsideButton: labelRect.right <= buttonRect.right - 8,
        labelIsConstrained: label.scrollWidth > label.clientWidth,
        textAlign: labelStyle.textAlign,
        textOverflow: labelStyle.textOverflow,
        whiteSpace: labelStyle.whiteSpace,
        overflowX: labelStyle.overflowX
      };
    })
  ).toEqual({
    labelLeftAligned: true,
    labelInsideButton: true,
    labelIsConstrained: true,
    textAlign: "left",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflowX: "hidden"
  });
  expect(
    await page.evaluate(() => {
      const previousSample = document.querySelector('[data-testid="sample-slot-4"]');
      const bloom = document.querySelector('[data-testid="sample-slot-5"]');
      const bloomAction = bloom.querySelector(".sample-chip__action");
      const eraser = document.querySelector('[data-testid="eraser-tool"]');
      const clear = document.querySelector('[data-testid="clear-paint"]');
      const sampleStack = document.querySelector('[data-testid="paint-swatches"]');
      const firstSample = document.querySelector('[data-testid="sample-slot-0"]');
      const speedSlider = document.querySelector('[data-testid="speed-slider"]');
      const previousSampleRect = previousSample.getBoundingClientRect();
      const bloomRect = bloom.getBoundingClientRect();
      const bloomActionRect = bloomAction.getBoundingClientRect();
      const eraserRect = eraser.getBoundingClientRect();
      const clearRect = clear.getBoundingClientRect();
      const stackRect = sampleStack.getBoundingClientRect();
      const firstSampleRect = firstSample.getBoundingClientRect();
      const speedSliderRect = speedSlider.getBoundingClientRect();
      const topGap = firstSampleRect.top - stackRect.top;
      const bottomGap = stackRect.bottom - clearRect.bottom;
      const sampleGap = bloomRect.top - previousSampleRect.bottom;
      const eraserGap = eraserRect.top - bloomRect.bottom;
      const sampleSectionHeight = clearRect.bottom - firstSampleRect.top;
      const expectedItemHeight = (speedSliderRect.height - 16) / 8;

      return {
        eraserBelowBloom: eraserRect.top >= bloomRect.bottom,
        clearBelowEraser: clearRect.top >= eraserRect.bottom,
        eraserMatchesSampleWidth: Math.abs(eraserRect.width - bloomRect.width) <= 1,
        clearMatchesSampleWidth: Math.abs(clearRect.width - bloomRect.width) <= 1,
        sampleButtonsHaveNoVerticalGap: Math.abs(sampleGap) <= 1,
        sampleButtonHeightMatchesSliderDivision:
          Math.abs(bloomActionRect.height - expectedItemHeight) <= 1,
        eraserHeightMatchesSample:
          Math.abs(eraserRect.height - bloomActionRect.height) <= 1,
        clearHeightMatchesSample:
          Math.abs(clearRect.height - bloomActionRect.height) <= 1,
        sampleSectionMatchesSliderHeight:
          Math.abs(sampleSectionHeight - speedSliderRect.height) <= 1,
        sampleSectionTopAlignsWithSlider:
          Math.abs(firstSampleRect.top - speedSliderRect.top) <= 2,
        sampleSectionBottomAlignsWithSlider:
          Math.abs(clearRect.bottom - speedSliderRect.bottom) <= 2,
        eraserSeparatedFromSampleButtons: Math.abs(eraserGap - 10) <= 1,
        eraserAlignsWithSample: Math.abs(eraserRect.left - bloomRect.left) <= 1,
        clearAlignsWithSample: Math.abs(clearRect.left - bloomRect.left) <= 1,
        verticallyCentered: Math.abs(topGap - bottomGap) <= 2
      };
    })
  ).toEqual({
    eraserBelowBloom: true,
    clearBelowEraser: true,
    eraserMatchesSampleWidth: true,
    clearMatchesSampleWidth: true,
    sampleButtonsHaveNoVerticalGap: true,
    sampleButtonHeightMatchesSliderDivision: true,
    eraserHeightMatchesSample: true,
    clearHeightMatchesSample: true,
    sampleSectionMatchesSliderHeight: true,
    sampleSectionTopAlignsWithSlider: true,
    sampleSectionBottomAlignsWithSlider: true,
    eraserSeparatedFromSampleButtons: true,
    eraserAlignsWithSample: true,
    clearAlignsWithSample: true,
    verticallyCentered: true
  });

  await expect(page.getByText("Optical Sample Turntable")).toHaveCount(0);
  await expect(page.getByText("Playable optical sample turntable")).toHaveCount(0);
  await expect(page.getByText("Phase 08")).toHaveCount(0);
  await expect(page.getByText("Turntable workspace")).toHaveCount(0);
  await expect(page.getByText("Audio starts only after the sampler is enabled.")).toHaveCount(0);
  await expect(page.getByText("reverse")).toHaveCount(0);
  await expect(page.getByText("forward")).toHaveCount(0);
  await expect(page.getByTestId("status-panel")).toHaveCount(0);
  await expect(page.getByTestId("audio-controls")).toHaveCount(0);
  await expect(page.getByTestId("transport-readout")).toHaveCount(0);
  await expect(page.getByTestId("playhead-analysis")).toHaveCount(0);
  await expect(page.getByTestId("voice-state")).toHaveCount(0);
  await expect(page.getByTestId("sample-meta-0")).toHaveCount(0);
  await expect(page.getByTestId("sample-voice-0")).toHaveCount(0);
  await expect(page.getByTestId("sample-loop-state-0")).toHaveCount(0);
  await expect(page.getByTestId("paint-status")).toHaveCount(0);

  const visualState = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="turntable-canvas"]');
      const visual = document.querySelector('[data-testid="turntable-visual"]');
      const base = document.querySelector('[data-testid="turntable-vector-base"]');
      const chrome = document.querySelector('[data-testid="turntable-vector-chrome"]');
      const rect = canvas.getBoundingClientRect();
      const visualRect = visual.getBoundingClientRect();
      const context = canvas.getContext("2d");
      const pixel = context.getImageData(
        Math.floor(canvas.width / 2),
        Math.floor(canvas.height / 2),
        1,
        1
      ).data;
      const markerY =
        rect.height / 2 - Math.min(rect.width, rect.height) * 0.42 * 0.48;
      const markerPixel = context.getImageData(
        Math.floor((rect.width / 2 / rect.width) * canvas.width),
        Math.floor((markerY / rect.height) * canvas.height),
        1,
        1
      ).data;
      const baseDisc = base.querySelector(".turntable-vector__disc");
      const hub = chrome.querySelector(".turntable-vector__hub");
      const hubBase = chrome.querySelector(".turntable-vector__hub-base");
      const hubSpiral = chrome.querySelector(".turntable-vector__hub-spiral");
      const hubRim = chrome.querySelector(".turntable-vector__hub-rim");
      const hubDot = chrome.querySelector(".turntable-vector__hub-dot");
      const playhead = chrome.querySelector(".turntable-vector__playhead");
      const playheadCore = chrome.querySelector(
        ".turntable-vector__playhead-core"
      );

      return {
        width: rect.width,
        height: rect.height,
        visualWidth: visualRect.width,
        visualHeight: visualRect.height,
        canvasCenterAlpha: pixel[3],
        markerPixel: Array.from(markerPixel),
        chromeZIndex: Number(getComputedStyle(chrome).zIndex),
        baseViewBox: base.getAttribute("viewBox"),
        chromeViewBox: chrome.getAttribute("viewBox"),
        baseDiscFill: baseDisc.getAttribute("fill"),
        baseDiscStroke: baseDisc.getAttribute("stroke"),
        baseDiscStrokeWidth: baseDisc.getAttribute("stroke-width"),
        hubFill: hub.getAttribute("fill"),
        hubStroke: hub.getAttribute("stroke"),
        hubPhaseTurns: hub.getAttribute("data-phase-turns"),
        hubTransform: hub.getAttribute("transform"),
        hubBaseFill: hubBase.getAttribute("fill"),
        hubBaseStroke: hubBase.getAttribute("stroke"),
        hubBaseStrokeWidth: hubBase.getAttribute("stroke-width"),
        hubSpiralRemoved: hubSpiral === null,
        hubRimRemoved: hubRim === null,
        hubDotRemoved: hubDot === null,
        playheadStroke: playhead.getAttribute("stroke"),
        playheadCoreStroke: playheadCore.getAttribute("stroke")
      };
    });

  expect(visualState.width).toBeGreaterThan(820);
  expect(visualState.height).toBeGreaterThan(820);
  expect(visualState.visualWidth).toBeCloseTo(visualState.width, 0);
  expect(visualState.visualHeight).toBeCloseTo(visualState.height, 0);
  expect(visualState.canvasCenterAlpha).toBe(0);
  expect(visualState.markerPixel.slice(0, 3)).toEqual([0, 0, 0]);
  expect(visualState.markerPixel[3]).toBeGreaterThanOrEqual(45);
  expect(visualState.markerPixel[3]).toBeLessThanOrEqual(55);
  expect(visualState.chromeZIndex).toBe(4);
  expect(visualState.baseViewBox).toBe(visualState.chromeViewBox);
  expect(visualState.baseDiscFill).toBe("#ffe6cc");
  expect(visualState.baseDiscStroke).toBe("#000000");
  expect(visualState.baseDiscStrokeWidth).toBe("1.5");
  expect(visualState.hubFill).toBe(null);
  expect(visualState.hubStroke).toBe(null);
  expect(visualState.hubPhaseTurns).toBe("0.000000");
  expect(visualState.hubTransform).toContain("rotate(0.000");
  expect(visualState.hubBaseFill).toBe("#8000ff");
  expect(visualState.hubBaseStroke).toBe("#000000");
  expect(visualState.hubBaseStrokeWidth).toBe(visualState.baseDiscStrokeWidth);
  expect(visualState.hubSpiralRemoved).toBe(true);
  expect(visualState.hubRimRemoved).toBe(true);
  expect(visualState.hubDotRemoved).toBe(true);
  expect(visualState.playheadStroke).toBe("rgba(0, 255, 128, 0.58)");
  expect(visualState.playheadCoreStroke).toBe("#8000ff");
  expect(
    await page.getByTestId("app-shell").evaluate((element) =>
      getComputedStyle(element).backgroundColor
    )
  ).toBe("rgb(255, 128, 0)");
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
  expect(await page.evaluate(() => window.__phaseEightAudioContextCreated)).toBe(0);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("deselects the active paint tool when the app background is clicked", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/");

  await expect(page.getByTestId("paint-controls")).toHaveAttribute(
    "data-paint-tool",
    "paint"
  );
  await expect(page.getByTestId("paint-controls")).toHaveAttribute(
    "data-selected-colour-index",
    "1"
  );
  await expect(page.getByTestId("sample-slot-0")).toHaveClass(/is-selected/);
  expect(
    await page
      .getByTestId("sample-name-0")
      .evaluate((element) => getComputedStyle(element).color)
  ).toBe("rgb(255, 0, 0)");

  const backgroundPoint = await page.evaluate(() => {
    const visual = document
      .querySelector('[data-testid="turntable-visual"]')
      .getBoundingClientRect();

    return {
      x: visual.left + 20,
      y: visual.top + 20
    };
  });

  expect(
    await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.dataset.testid,
      backgroundPoint
    )
  ).toBe("turntable-canvas");

  await page.mouse.click(backgroundPoint.x, backgroundPoint.y);

  await expect(page.getByTestId("paint-controls")).toHaveAttribute(
    "data-paint-tool",
    "none"
  );
  await expect(page.getByTestId("paint-controls")).toHaveAttribute(
    "data-selected-colour-index",
    "none"
  );
  await expect(page.getByTestId("sample-slot-0")).not.toHaveClass(/is-selected/);
  await expect(page.getByTestId("paint-colour-1")).toHaveAttribute(
    "aria-pressed",
    "false"
  );
  expect(
    await page
      .getByTestId("sample-name-0")
      .evaluate((element) => getComputedStyle(element).color)
  ).toBe("rgb(255, 230, 204)");

  const canvas = page.getByTestId("turntable-canvas");
  const start = await getCanvasPoint(canvas, 0.72, 0.5);
  const end = await getCanvasPoint(canvas, 0.8, 0.5);
  const samplePoint = await getCanvasPoint(canvas, 0.76, 0.5);
  const before = await sampleCanvasPixel(page, samplePoint.x, samplePoint.y);

  await dispatchPointer(canvas, "pointerdown", start);
  await dispatchPointer(canvas, "pointermove", end);
  await dispatchPointer(canvas, "pointerup", end);
  await page.waitForTimeout(80);

  expect(await sampleCanvasPixel(page, samplePoint.x, samplePoint.y)).toEqual(
    before
  );
  await expect(canvas).toHaveAttribute("data-pointer-capture-requested", "true");
  await expect(canvas).toHaveAttribute("data-platter-grab-active", "false");
  await expect(canvas).toHaveAttribute("data-canvas-interaction", "none");

  await page.getByTestId("paint-colour-2").click();
  await expect(page.getByTestId("paint-controls")).toHaveAttribute(
    "data-paint-tool",
    "paint"
  );
  await expect(page.getByTestId("paint-controls")).toHaveAttribute(
    "data-selected-colour-index",
    "2"
  );
  await expect(page.getByTestId("sample-slot-1")).toHaveClass(/is-selected/);
});

test("no selected colour canvas drag rotates the platter without painting and unlocks audio", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await installFakePlaybackAudio(page);
  await page.goto("/");

  const canvas = page.getByTestId("turntable-canvas");

  await clearPaintSelectionWithCanvasBackground(page);
  await expect(canvas).toHaveAttribute("data-transport-playing", "false");
  expect(await page.evaluate(() => window.__phaseEightAudioDebug.contextsCreated)).toBe(0);

  const start = await getCanvasPoint(canvas, 0.74, 0.5);
  const move = await getCanvasPoint(canvas, 0.5, 0.26);
  const beforePhase = await readTransportPhase(page);
  const beforePaint = await countCanvasPaintComponents(page);

  await dispatchPointer(canvas, "pointerdown", start, 41);
  await expect(canvas).toHaveAttribute("data-pointer-capture-requested", "true");
  await expect(canvas).toHaveAttribute("data-platter-grab-active", "true");
  await expect(canvas).toHaveAttribute("data-canvas-interaction", "platter");
  await expect
    .poll(async () => page.evaluate(() => window.__phaseEightAudioDebug.contextsCreated))
    .toBe(1);

  await dispatchPointer(canvas, "pointermove", move, 41);
  const movedPhase = await readTransportPhase(page);

  expect(Math.abs(movedPhase - beforePhase)).toBeGreaterThan(0.01);

  await dispatchPointer(canvas, "pointerup", move, 41);
  await page.waitForTimeout(80);

  const afterPaint = await countCanvasPaintComponents(page);

  expect(Math.abs(afterPaint.paintedPixelCount - beforePaint.paintedPixelCount)).toBeLessThan(80);
  await expect(canvas).toHaveAttribute("data-platter-grab-active", "false");
  await expect(canvas).toHaveAttribute("data-canvas-interaction", "none");
  await expect(canvas).toHaveAttribute("data-transport-playing", "false");
});

test("platter drag keeps its interaction mode through tool changes and outside-disc moves", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/");

  const canvas = page.getByTestId("turntable-canvas");

  await clearPaintSelectionWithCanvasBackground(page);

  const start = await getCanvasPoint(canvas, 0.74, 0.5);
  const outside = await getCanvasPoint(canvas, 1.08, 0.2);
  const beforePhase = await readTransportPhase(page);

  await dispatchPointer(canvas, "pointerdown", start, 51);
  await expect(canvas).toHaveAttribute("data-canvas-interaction", "platter");

  await page.getByTestId("paint-colour-2").evaluate((button) => button.click());
  await expect(page.getByTestId("paint-controls")).toHaveAttribute(
    "data-paint-tool",
    "paint"
  );
  await expect(page.getByTestId("paint-controls")).toHaveAttribute(
    "data-selected-colour-index",
    "2"
  );

  await dispatchPointer(canvas, "pointermove", outside, 51);
  const movedPhase = await readTransportPhase(page);

  expect(Math.abs(movedPhase - beforePhase)).toBeGreaterThan(0.01);
  await expect(canvas).toHaveAttribute("data-canvas-interaction", "platter");

  await dispatchPointer(canvas, "pointerup", outside, 51);
  await expect(canvas).toHaveAttribute("data-canvas-interaction", "none");
  await expect(canvas).toHaveAttribute("data-platter-grab-active", "false");
});

test("uses the first Play gesture to unlock audio and Pause ramps down without resetting phase", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await installFakePlaybackAudio(page);
  await page.goto("/");

  const playButton = page.getByTestId("transport-play");
  const canvas = page.getByTestId("turntable-canvas");

  await expect(playButton).toHaveText("");
  await expect(playButton).toHaveAttribute("aria-label", "Play");
  await expect(page.getByTestId("transport-play-icon")).toBeVisible();
  await expect(page.getByTestId("transport-pause-icon")).not.toBeVisible();
  expect(await page.evaluate(() => window.__phaseEightAudioDebug.contextsCreated)).toBe(0);

  await playButton.click();
  await expect(playButton).toHaveText("");
  await expect(playButton).toHaveAttribute("aria-label", "Pause");
  await expect(page.getByTestId("transport-play-icon")).not.toBeVisible();
  await expect(page.getByTestId("transport-pause-icon")).toBeVisible();
  await expect(canvas).toHaveAttribute("data-transport-playing", "true");
  await expect
    .poll(async () => page.evaluate(() => window.__phaseEightAudioDebug.contextsCreated))
    .toBe(1);
  await expect
    .poll(async () => page.evaluate(() => window.__phaseEightAudioDebug.modules))
    .toEqual(["/worklets/sampler-worklet.js"]);
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__phaseEightAudioDebug.messages.filter(
            (message) => message.type === "setSample"
          ).length
      )
    )
    .toBeGreaterThan(0);

  const centerButtonStart = await readCenterPlayButtonState(page);
  const movingStart = await readTransportPhase(page);
  await page.waitForTimeout(180);
  const centerButtonEnd = await readCenterPlayButtonState(page);
  const movingEnd = centerButtonEnd.canvasPhaseTurns;

  expect(movingEnd).toBeGreaterThan(movingStart);
  expect(Math.abs(centerButtonEnd.phaseTurns - movingEnd)).toBeLessThan(0.000002);
  expect(
    Math.abs(centerButtonEnd.rotationDegrees - -movingEnd * 360)
  ).toBeLessThan(0.002);
  expect(centerButtonEnd.transform).not.toBe(centerButtonStart.transform);

  await playButton.click();
  await expect(playButton).toHaveText("");
  await expect(playButton).toHaveAttribute("aria-label", "Play");
  await expect(page.getByTestId("transport-play-icon")).toBeVisible();
  await expect(page.getByTestId("transport-pause-icon")).not.toBeVisible();
  await expect(canvas).toHaveAttribute("data-transport-playing", "false");

  const rampStartPhase = await readTransportPhase(page);
  await page.waitForTimeout(220);
  const midRampPhase = await readTransportPhase(page);
  await page.waitForTimeout(520);
  const stoppedPhase = await readTransportPhase(page);
  await page.waitForTimeout(220);
  const laterStoppedPhase = await readTransportPhase(page);

  expect(midRampPhase).toBeGreaterThan(rampStartPhase);
  expect(stoppedPhase).toBeGreaterThan(midRampPhase);
  expect(Math.abs(laterStoppedPhase - stoppedPhase)).toBeLessThan(0.001);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const transportMessages = window.__phaseEightAudioDebug.messages.filter(
          (message) => message.type === "setTransport"
        );

        const latestSpeed = transportMessages.slice(-1)[0]?.actualGlobalSpeed;

        return Number.isFinite(latestSpeed) ? Math.abs(latestSpeed) : null;
      })
    )
    .toBeLessThanOrEqual(0.02);

  await playButton.click();
  await expect(playButton).toHaveText("");
  await expect(playButton).toHaveAttribute("aria-label", "Pause");
  expect(await page.evaluate(() => window.__phaseEightAudioDebug.contextsCreated)).toBe(1);
});

test("painted material under the playhead starts a sampler voice while loop controls stay hidden", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await installFakePlaybackAudio(page);
  await page.goto("/");

  await page.getByTestId("transport-play").click();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__phaseEightAudioDebug.messages.filter(
            (message) => message.type === "setSample"
          ).length
      )
    )
    .toBeGreaterThanOrEqual(6);
  await expect
    .poll(async () =>
      page.evaluate(() =>
        window.__phaseEightAudioDebug.messages.some(
          (message) => message.type === "setLoopDefaults"
        )
      )
    )
    .toBe(true);

  const canvas = page.getByTestId("turntable-canvas");
  const point = await getCanvasPoint(canvas, 0.5, 0.25);
  const inactiveSampleGeometry = await page
    .getByTestId("sample-slot-0")
    .evaluate((slot) => {
      const action = slot.querySelector(".sample-chip__action");
      const select = slot.querySelector('[data-testid="paint-colour-1"]');
      const upload = slot.querySelector('[data-testid="sample-upload-label-0"]');
      const actionRect = action.getBoundingClientRect();
      const selectRect = select.getBoundingClientRect();
      const uploadRect = upload.getBoundingClientRect();

      return {
        actionWidth: actionRect.width,
        actionHeight: actionRect.height,
        selectWidth: selectRect.width,
        selectHeight: selectRect.height,
        uploadWidth: uploadRect.width,
        uploadHeight: uploadRect.height
      };
    });

  await dispatchPointer(canvas, "pointerdown", { x: point.x - 24, y: point.y }, 7);
  await dispatchPointer(canvas, "pointermove", point, 7);
  await dispatchPointer(canvas, "pointermove", { x: point.x + 24, y: point.y }, 7);
  await dispatchPointer(canvas, "pointerup", { x: point.x + 24, y: point.y }, 7);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const message = window.__phaseEightAudioDebug.messages.find(
          (candidate) => candidate.type === "startVoice"
        );

        return message ? message.voice : null;
      })
    )
    .not.toBeNull();

  const startedVoice = await page.evaluate(() => {
    const message = window.__phaseEightAudioDebug.messages.find(
      (candidate) => candidate.type === "startVoice"
    );

    return message.voice;
  });

  expect(startedVoice.slotIndex).toBe(0);
  await expect(page.getByTestId("sample-slot-0")).toHaveClass(/is-sounding/);
  const activeSampleState = await page
    .getByTestId("sample-slot-0")
    .evaluate((slot) => {
      const action = slot.querySelector(".sample-chip__action");
      const select = slot.querySelector('[data-testid="paint-colour-1"]');
      const sampleName = slot.querySelector('[data-testid="sample-name-0"]');
      const upload = slot.querySelector('[data-testid="sample-upload-label-0"]');
      const activeStroke = getComputedStyle(action, "::before");
      const selectStyle = getComputedStyle(select);
      const sampleNameStyle = getComputedStyle(sampleName);
      const uploadStyle = getComputedStyle(upload);
      const actionRect = action.getBoundingClientRect();
      const selectRect = select.getBoundingClientRect();
      const uploadRect = upload.getBoundingClientRect();

      return {
        selectBorderColor: selectStyle.borderColor,
        selectBorderTopWidth: selectStyle.borderTopWidth,
        selectBorderRightWidth: selectStyle.borderRightWidth,
        activeStrokeContent: activeStroke.content,
        activeStrokeWidth: activeStroke.borderTopWidth,
        activeSampleTextColour: sampleNameStyle.color,
        uploadBorderColor: uploadStyle.borderColor,
        uploadBorderLeftWidth: uploadStyle.borderLeftWidth,
        uploadBorderTopWidth: uploadStyle.borderTopWidth,
        uploadBackground: uploadStyle.backgroundColor,
        actionWidth: actionRect.width,
        actionHeight: actionRect.height,
        selectWidth: selectRect.width,
        selectHeight: selectRect.height,
        uploadWidth: uploadRect.width,
        uploadHeight: uploadRect.height
      };
    });

  expect(activeSampleState).toMatchObject({
    selectBorderColor: "rgb(255, 230, 204)",
    selectBorderTopWidth: "0px",
    selectBorderRightWidth: "0px",
    activeStrokeContent: "none",
    activeStrokeWidth: "0px",
    activeSampleTextColour: "rgb(0, 255, 0)",
    uploadBorderColor: "rgb(255, 230, 204)",
    uploadBorderLeftWidth: "0px",
    uploadBorderTopWidth: "0px",
    uploadBackground: "rgb(255, 128, 0)"
  });
  expect(activeSampleState.actionWidth).toBeCloseTo(
    inactiveSampleGeometry.actionWidth,
    2
  );
  expect(activeSampleState.actionHeight).toBeCloseTo(
    inactiveSampleGeometry.actionHeight,
    2
  );
  expect(activeSampleState.selectWidth).toBeCloseTo(
    inactiveSampleGeometry.selectWidth,
    2
  );
  expect(activeSampleState.selectHeight).toBeCloseTo(
    inactiveSampleGeometry.selectHeight,
    2
  );
  expect(activeSampleState.uploadWidth).toBeCloseTo(
    inactiveSampleGeometry.uploadWidth,
    2
  );
  expect(activeSampleState.uploadHeight).toBeCloseTo(
    inactiveSampleGeometry.uploadHeight,
    2
  );
  await expect(page.getByTestId("sample-voice-0")).toHaveCount(0);
  await expect(page.getByTestId("global-loop")).toHaveCount(0);
  await expect(page.getByTestId("global-loop-status")).toHaveCount(0);
  await expect(page.getByTestId("sample-loop-0")).toHaveCount(0);
  await expect(page.getByTestId("sample-loop-state-0")).toHaveCount(0);
});

test("in-progress drawing can start a sampler voice before pointer release", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await installFakePlaybackAudio(page);
  await page.goto("/");

  await page.getByTestId("transport-play").click();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__phaseEightAudioDebug.messages.filter(
            (message) => message.type === "setSample"
          ).length
      )
    )
    .toBeGreaterThanOrEqual(6);

  const canvas = page.getByTestId("turntable-canvas");
  const point = await getCanvasPoint(canvas, 0.5, 0.25);

  await dispatchPointer(canvas, "pointerdown", { x: point.x - 20, y: point.y }, 17);
  await dispatchPointer(canvas, "pointermove", point, 17);

  await expect
    .poll(async () =>
      page.evaluate(() =>
        window.__phaseEightAudioDebug.messages.some(
          (message) => message.type === "startVoice"
        )
      )
    )
    .toBe(true);

  await dispatchPointer(canvas, "pointerup", point, 17);
});

test("replaces an uploaded sample without adding removed status labels", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("sample-name-1")).toHaveText("Snare");
  await expect(page.getByTestId("sample-meta-1")).toHaveCount(0);
  await expect(
    page
      .getByTestId("sample-upload-label-1")
      .locator(".sample-chip__upload-icon")
  ).toHaveCount(1);
  await expect(page.getByText("Replace")).toHaveCount(0);
  await expect(page.getByTestId("paint-controls")).toHaveAttribute(
    "data-selected-colour-index",
    "1"
  );

  const fileChooserPromise = page.waitForEvent("filechooser");

  await page.getByTestId("sample-upload-label-1").click();
  await (await fileChooserPromise).setFiles("public/samples/snare.wav");

  await expect(page.getByTestId("sample-name-1")).toHaveText("snare");
  await expect(page.getByTestId("sample-meta-1")).toHaveCount(0);
  await expect(page.getByTestId("paint-controls")).toHaveAttribute(
    "data-selected-colour-index",
    "1"
  );

  await page.getByTestId("paint-colour-3").click();
  await expect(page.getByTestId("paint-controls")).toHaveAttribute(
    "data-selected-colour-index",
    "3"
  );
});

test("persists uploaded samples across page reloads", async ({ page }) => {
  await page.goto("/");
  await clearSavedSampleStorage(page);
  await page.reload();

  await expect(page.getByTestId("sample-name-1")).toHaveText("Snare");

  await page.getByTestId("sample-upload-1").setInputFiles("public/samples/snare.wav");
  await expect(page.getByTestId("sample-name-1")).toHaveText("snare");

  await page.reload();

  await expect(page.getByTestId("sample-name-1")).toHaveText("snare");
  await clearSavedSampleStorage(page);
});

test("accepts fine speed increments without reverse-forward helper labels", async ({ page }) => {
  await installFakePlaybackAudio(page);
  await page.goto("/");

  const playButton = page.getByTestId("transport-play");
  const slider = page.getByTestId("speed-slider");

  await expect(slider).toHaveAttribute("step", "0.01");
  await expect(page.getByText("reverse")).toHaveCount(0);
  await expect(page.getByText("forward")).toHaveCount(0);
  await expect(page.getByTestId("speed-ticks").locator("span")).toHaveText([
    "+4",
    "+2",
    "+1",
    "0",
    "-1",
    "-2",
    "-4"
  ]);
  expect(
    await slider.evaluate((input) => {
      const rect = input.getBoundingClientRect();

      return rect.height > rect.width * 3;
    })
  ).toBe(true);
  expect(
    await page.evaluate(() => {
      const sliderElement = document.querySelector('[data-testid="speed-slider"]');
      const trackElement = document.querySelector('[data-testid="speed-track"]');
      const thumbElement = document.querySelector('[data-testid="speed-thumb"]');
      const sliderRect = sliderElement.getBoundingClientRect();
      const trackRect = trackElement.getBoundingClientRect();
      const thumbRect = thumbElement.getBoundingClientRect();
      const tickRect = document
        .querySelector('[data-testid="speed-ticks"]')
        .getBoundingClientRect();
      const speedControl = document.querySelector(".speed-control");
      const speedControlRect = speedControl.getBoundingClientRect();
      const speedLabelRect = document
        .querySelector(".speed-control__header")
        .getBoundingClientRect();
      const speedLabelStyle = getComputedStyle(
        document.querySelector(".speed-control__header")
      );
      const firstTickStyle = getComputedStyle(
        document.querySelector('[data-testid="speed-ticks"] span')
      );
      const sliderStyle = getComputedStyle(sliderElement);
      const trackStyle = getComputedStyle(trackElement);
      const thumbStyle = getComputedStyle(thumbElement);
      const rowGap = Number.parseFloat(getComputedStyle(speedControl).rowGap) || 0;
      const columnGap =
        Number.parseFloat(getComputedStyle(speedControl).columnGap) || 0;
      const sliderCenterY = (sliderRect.top + sliderRect.bottom) / 2;
      const sliderCenterX = (sliderRect.left + sliderRect.right) / 2;
      const trackCenterX = (trackRect.left + trackRect.right) / 2;
      const thumbCenterX = (thumbRect.left + thumbRect.right) / 2;
      const thumbCenterY = (thumbRect.top + thumbRect.bottom) / 2;
      const expectedThumbCenterY =
        trackRect.bottom - trackRect.height * (Number(sliderElement.value) + 4) / 8;
      const speedLabelCenterX =
        (speedLabelRect.left + speedLabelRect.right) / 2;
      const speedControlCenterY =
        (speedControlRect.top + speedControlRect.bottom) / 2;

      return {
        sliderAccentColor: sliderStyle.accentColor,
        sliderBackgroundColor: sliderStyle.backgroundColor,
        sliderOpacity: sliderStyle.opacity,
        trackBackgroundImage: trackStyle.backgroundImage,
        trackWidth: `${Math.round(trackRect.width)}px`,
        sliderFillPercent: sliderStyle
          .getPropertyValue("--speed-fill-percent")
          .trim(),
        sliderTrackColour: sliderStyle
          .getPropertyValue("--speed-track-colour")
          .trim(),
        sliderTrackFill: sliderStyle.getPropertyValue("--speed-track-fill").trim(),
        sliderThumbSize: sliderStyle.getPropertyValue("--speed-thumb-size").trim(),
        sliderThumbColour: sliderStyle
          .getPropertyValue("--speed-thumb-colour")
          .trim(),
        thumbBackground: thumbStyle.backgroundColor,
        thumbHasShadow: thumbStyle.boxShadow !== "none",
        thumbWidth: `${Math.round(thumbRect.width)}px`,
        thumbHeight: `${Math.round(thumbRect.height)}px`,
        thumbHorizontallyCenteredOnTrack:
          Math.abs(thumbCenterX - trackCenterX) <= 0.5,
        thumbAlignedToFill:
          Math.abs(thumbCenterY - expectedThumbCenterY) <= 0.5,
        tickColour: firstTickStyle.color,
        speedLabelColour: speedLabelStyle.color,
        labelsRightOfSlider: tickRect.left >= sliderRect.right,
        labelsHalfAsFarFromSlider:
          tickRect.left - sliderRect.right <= 8 &&
          columnGap <= 3,
        labelsShareSliderHeight:
          Math.abs(tickRect.top - sliderRect.top) <= 2 &&
          Math.abs(tickRect.bottom - sliderRect.bottom) <= 2,
        speedLabelBelowSlider: speedLabelRect.top >= sliderRect.bottom,
        speedLabelDirectlyBelowSlider:
          Math.abs(speedLabelRect.top - sliderRect.bottom - rowGap) <= 2,
        speedLabelAlignedWithSlider:
          Math.abs(speedLabelCenterX - sliderCenterX) <= 6,
        sliderVerticallyCentered:
          Math.abs(sliderCenterY - speedControlCenterY) <= 3
      };
    })
  ).toEqual({
    sliderAccentColor: "rgb(0, 255, 128)",
    sliderBackgroundColor: "rgba(0, 0, 0, 0)",
    sliderOpacity: "0",
    trackBackgroundImage:
      "linear-gradient(to top, rgb(255, 230, 204) 0px, rgb(255, 230, 204) 62.5%, rgb(255, 230, 204) 62.5%, rgb(255, 230, 204) 100%)",
    trackWidth: "8px",
    sliderFillPercent: "62.50%",
    sliderTrackColour: "#ffe6cc",
    sliderTrackFill: "#ffe6cc",
    sliderThumbSize: "40px",
    sliderThumbColour: "#00ff80",
    thumbBackground: "rgb(0, 255, 128)",
    thumbHasShadow: true,
    thumbWidth: "40px",
    thumbHeight: "40px",
    thumbHorizontallyCenteredOnTrack: true,
    thumbAlignedToFill: true,
    tickColour: "rgb(255, 230, 204)",
    speedLabelColour: "rgb(255, 230, 204)",
    labelsRightOfSlider: true,
    labelsHalfAsFarFromSlider: true,
    labelsShareSliderHeight: true,
    speedLabelBelowSlider: true,
    speedLabelDirectlyBelowSlider: true,
    speedLabelAlignedWithSlider: true,
    sliderVerticallyCentered: true
  });

  await playButton.click();
  await expect(playButton).toHaveText("");
  await expect(playButton).toHaveAttribute("aria-label", "Pause");

  await slider.evaluate((input) => {
    input.value = "0.37";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(slider).toHaveValue("0.37");
  await expect
    .poll(() =>
      slider.evaluate((input) =>
        getComputedStyle(input).getPropertyValue("--speed-fill-percent").trim()
      )
    )
    .toBe("54.63%");
  expect(
    await page.evaluate(() => {
      const sliderElement = document.querySelector('[data-testid="speed-slider"]');
      const trackRect = document
        .querySelector('[data-testid="speed-track"]')
        .getBoundingClientRect();
      const thumbRect = document
        .querySelector('[data-testid="speed-thumb"]')
        .getBoundingClientRect();
      const trackCenterX = (trackRect.left + trackRect.right) / 2;
      const thumbCenterX = (thumbRect.left + thumbRect.right) / 2;
      const thumbCenterY = (thumbRect.top + thumbRect.bottom) / 2;
      const fillRatio = (Number(sliderElement.value) + 4) / 8;
      const expectedThumbCenterY = trackRect.bottom - trackRect.height * fillRatio;

      return {
        centered: Math.abs(thumbCenterX - trackCenterX) <= 0.5,
        followsFill: Math.abs(thumbCenterY - expectedThumbCenterY) <= 0.5
      };
    })
  ).toEqual({
    centered: true,
    followsFill: true
  });

  const phaseStart = await readTransportPhase(page);
  await page.waitForTimeout(220);
  const phaseEnd = await readTransportPhase(page);

  expect(phaseEnd).toBeGreaterThan(phaseStart);
});

test("paints, erases, and clears score-backed marks through pointer input", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/");

  const canvas = page.getByTestId("turntable-canvas");
  await page.getByTestId("paint-colour-2").click();
  await canvas.scrollIntoViewIfNeeded();

  const start = await getCanvasPoint(canvas, 0.72, 0.5);
  const end = await getCanvasPoint(canvas, 0.8, 0.5);
  const samplePoint = await getCanvasPoint(canvas, 0.76, 0.5);

  const before = await sampleCanvasPixel(page, samplePoint.x, samplePoint.y);
  expect(before[3]).toBeLessThan(96);

  await dispatchPointer(canvas, "pointerdown", start);
  await expect(canvas).toHaveAttribute("data-pointer-capture-requested", "true");
  for (let step = 1; step <= 8; step += 1) {
    await dispatchPointer(canvas, "pointermove", {
      x: start.x + ((end.x - start.x) * step) / 8,
      y: start.y
    });
  }
  await dispatchPointer(canvas, "pointerup", end);
  await page.waitForTimeout(80);

  const afterPaint = await sampleCanvasPixel(page, samplePoint.x, samplePoint.y);

  expect(afterPaint[3]).toBeGreaterThan(0);
  expect(colourDistance(afterPaint, before)).toBeGreaterThan(20);
  expect(afterPaint[0]).toBeGreaterThanOrEqual(140);
  expect(afterPaint[0]).toBeGreaterThan(afterPaint[1]);
  expect(afterPaint[1]).toBeGreaterThan(afterPaint[2]);
  expect(afterPaint[1]).toBeLessThan(140);
  expect(afterPaint[2]).toBeLessThan(40);

  await page.getByTestId("eraser-tool").click();
  await expect(page.getByTestId("paint-controls")).toHaveAttribute(
    "data-paint-tool",
    "erase"
  );
  expect(
    await page.getByTestId("eraser-tool").evaluate((button) => {
      const selectedStroke = getComputedStyle(button, "::before");

      return {
        borderColor: selectedStroke.borderTopColor,
        borderWidth: selectedStroke.borderTopWidth,
        boxShadow: getComputedStyle(button).boxShadow
      };
    })
  ).toEqual({
    borderColor: "rgb(255, 0, 0)",
    borderWidth: "7px",
    boxShadow: "none"
  });
  const eraseStart = {
    x: samplePoint.x - 36,
    y: samplePoint.y
  };
  const eraseEnd = {
    x: samplePoint.x + 36,
    y: samplePoint.y
  };

  await dispatchPointer(canvas, "pointerdown", eraseStart);
  for (let step = 1; step <= 12; step += 1) {
    await dispatchPointer(canvas, "pointermove", {
      x: eraseStart.x + ((eraseEnd.x - eraseStart.x) * step) / 12,
      y: eraseStart.y
    });
  }
  await dispatchPointer(canvas, "pointerup", eraseEnd);
  await page.waitForTimeout(80);

  const afterErase = await sampleCanvasPixel(page, samplePoint.x, samplePoint.y);

  expect(colourDistance(afterErase, before)).toBeLessThan(
    colourDistance(afterPaint, before)
  );

  await page.getByTestId("paint-colour-2").click();
  await dispatchPointer(canvas, "pointerdown", start, 9);
  await dispatchPointer(canvas, "pointermove", end, 9);
  await dispatchPointer(canvas, "pointerup", end, 9);
  await page.waitForTimeout(80);
  await page.getByTestId("clear-paint").click();
  await page.waitForTimeout(80);

  const afterClear = await sampleCanvasPixel(page, samplePoint.x, samplePoint.y);

  expect(colourDistance(afterClear, before)).toBeLessThan(8);
  expect(colourDistance(afterClear, afterPaint)).toBeGreaterThan(20);
});

test("keeps a dragged stroke visually connected when it crosses the central hub", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/");

  const canvas = page.getByTestId("turntable-canvas");
  const start = await getCanvasPoint(canvas, 0.35, 0.5);
  const end = await getCanvasPoint(canvas, 0.65, 0.5);

  await dispatchPointer(canvas, "pointerdown", start);
  for (let step = 1; step <= 20; step += 1) {
    await dispatchPointer(canvas, "pointermove", {
      x: start.x + ((end.x - start.x) * step) / 20,
      y: start.y
    });
  }
  await dispatchPointer(canvas, "pointerup", end);
  await page.waitForTimeout(80);

  const connectedPaint = await countCanvasPaintComponents(page);

  expect(connectedPaint.paintedPixelCount).toBeGreaterThan(0);
  expect(connectedPaint.componentCount).toBe(1);
  expect(connectedPaint.largestComponentSize).toBe(
    connectedPaint.paintedPixelCount
  );
});

test("supports touch-style pointer drawing where Pointer Events are available", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto("/");

  const canvas = page.getByTestId("turntable-canvas");
  const start = await getCanvasPoint(canvas, 0.5, 0.28);
  const end = {
    x: start.x + 28,
    y: start.y
  };

  await dispatchPointer(canvas, "pointerdown", start, 31, "touch");
  await dispatchPointer(canvas, "pointermove", end, 31, "touch");
  await dispatchPointer(canvas, "pointerup", end, 31, "touch");

  await expect(canvas).toHaveAttribute("data-pointer-capture-requested", "true");
  await expect(page.getByTestId("paint-controls")).toHaveAttribute(
    "data-selected-colour-index",
    "1"
  );
});

test("keeps the full-screen instrument layout inside release viewports", async ({ page }) => {
  for (const viewport of [
    { width: 390, height: 760 },
    { width: 1024, height: 768 },
    { width: 1440, height: 1100 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.getByTestId("sample-upload-0").setInputFiles("public/samples/kick.wav");
    await expect(page.getByTestId("sample-name-0")).toHaveText("kick");

    const layout = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="turntable-canvas"]');
      const visual = document.querySelector('[data-testid="turntable-visual"]');
      const paintControls = document.querySelector('[data-testid="paint-controls"]');
      const transportControls = document.querySelector(
        '[data-testid="transport-controls"]'
      );
      const playButton = document.querySelector('[data-testid="transport-play"]');
      const playIcon = document.querySelector('[data-testid="transport-play-icon"]');
      const pauseIcon = document.querySelector('[data-testid="transport-pause-icon"]');
      const paintSwatches = document.querySelector('[data-testid="paint-swatches"]');
      const speedSlider = document.querySelector('[data-testid="speed-slider"]');
      const speedThumb = document.querySelector('[data-testid="speed-thumb"]');
      const sampleZero = document.querySelector('[data-testid="sample-slot-0"]');
      const sampleOne = document.querySelector('[data-testid="sample-slot-1"]');
      const sampleFive = document.querySelector('[data-testid="sample-slot-5"]');
      const sampleName = document.querySelector('[data-testid="sample-name-0"]');
      const sampleSwatch = document.querySelector('[data-testid="paint-colour-1"]');
      const sampleAction = sampleZero.querySelector(".sample-chip__action");
      const sampleFiveAction = sampleFive.querySelector(".sample-chip__action");
      const sampleUpload = document.querySelector('[data-testid="sample-upload-label-0"]');
      const sampleUploadIcon = sampleUpload.querySelector(".sample-chip__upload-icon");
      const eraserLabel = document.querySelector(
        '[data-testid="eraser-tool"] .tool-button__label'
      );
      const clearLabel = document.querySelector(
        '[data-testid="clear-paint"] .tool-button__label'
      );
      const eraserIcon = document.querySelector('[data-testid="eraser-tool-icon"]');
      const clearIcon = document.querySelector('[data-testid="clear-tool-icon"]');
      const eraserButton = document.querySelector('[data-testid="eraser-tool"]');
      const clearButton = document.querySelector('[data-testid="clear-paint"]');
      const canvasRect = canvas.getBoundingClientRect();
      const visualRect = visual.getBoundingClientRect();
      const paintRect = paintControls.getBoundingClientRect();
      const transportRect = transportControls.getBoundingClientRect();
      const paintStyle = getComputedStyle(paintControls);
      const transportStyle = getComputedStyle(transportControls);
      const playButtonRect = playButton.getBoundingClientRect();
      const speedSliderRect = speedSlider.getBoundingClientRect();
      const sampleZeroRect = sampleZero.getBoundingClientRect();
      const sampleOneRect = sampleOne.getBoundingClientRect();
      const sampleFiveRect = sampleFive.getBoundingClientRect();
      const paintSwatchesRect = paintSwatches.getBoundingClientRect();
      const paintSwatchesStyle = getComputedStyle(paintSwatches);
      const sampleSwatchRect = sampleSwatch.getBoundingClientRect();
      const sampleActionRect = sampleAction.getBoundingClientRect();
      const sampleUploadRect = sampleUpload.getBoundingClientRect();
      const sampleUploadIconRect = sampleUploadIcon.getBoundingClientRect();
      const eraserRect = eraserButton.getBoundingClientRect();
      const clearRect = clearButton.getBoundingClientRect();
      const readSpeedThumbBounds = (value) => {
        speedSlider.value = value;
        speedSlider.dispatchEvent(new Event("input", { bubbles: true }));

        const speedThumbRect = speedThumb.getBoundingClientRect();

        return {
          left: speedThumbRect.left,
          right: speedThumbRect.right
        };
      };

      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        pageWidth: document.documentElement.scrollWidth,
        pageHeight: document.documentElement.scrollHeight,
        canvas: {
          width: canvasRect.width,
          height: canvasRect.height,
          top: canvasRect.top,
          bottom: canvasRect.bottom,
          left: canvasRect.left,
          right: canvasRect.right
        },
        paint: {
          width: paintRect.width,
          height: paintRect.height,
          top: paintRect.top,
          bottom: paintRect.bottom,
          left: paintRect.left,
          right: paintRect.right,
          paddingLeft: Number.parseFloat(paintStyle.paddingLeft),
          paddingRight: Number.parseFloat(paintStyle.paddingRight),
          paddingTop: Number.parseFloat(paintStyle.paddingTop),
          paddingBottom: Number.parseFloat(paintStyle.paddingBottom)
        },
        transport: {
          width: transportRect.width,
          height: transportRect.height,
          top: transportRect.top,
          bottom: transportRect.bottom,
          left: transportRect.left,
          right: transportRect.right,
          paddingLeft: Number.parseFloat(transportStyle.paddingLeft),
          paddingRight: Number.parseFloat(transportStyle.paddingRight),
          paddingTop: Number.parseFloat(transportStyle.paddingTop),
          paddingBottom: Number.parseFloat(transportStyle.paddingBottom)
        },
        playButton: {
          text: playButton.textContent,
          width: playButtonRect.width,
          height: playButtonRect.height,
          centerX: (playButtonRect.left + playButtonRect.right) / 2,
          centerY: (playButtonRect.top + playButtonRect.bottom) / 2,
          visualCenterX: (visualRect.left + visualRect.right) / 2,
          visualCenterY: (visualRect.top + visualRect.bottom) / 2,
          inTransportControls: Boolean(
            playButton.closest('[data-testid="transport-controls"]')
          ),
          inTurntableVisual: Boolean(
            playButton.closest('[data-testid="turntable-visual"]')
          ),
          playIconDisplay: getComputedStyle(playIcon).display,
          pauseIconDisplay: getComputedStyle(pauseIcon).display,
          ariaLabel: playButton.getAttribute("aria-label"),
          ariaPressed: playButton.getAttribute("aria-pressed")
        },
        speedSlider: {
          width: speedSliderRect.width,
          height: speedSliderRect.height,
          top: speedSliderRect.top,
          bottom: speedSliderRect.bottom,
          thumbAtMinimum: readSpeedThumbBounds(speedSlider.min),
          thumbAtMaximum: readSpeedThumbBounds(speedSlider.max)
        },
        samples: {
          firstTop: sampleZeroRect.top,
          lastTop: sampleFiveRect.top,
          firstLeft: sampleZeroRect.left,
          firstRight: sampleZeroRect.right,
          secondLeft: sampleOneRect.left,
          lastLeft: sampleFiveRect.left,
          stripClientWidth: paintSwatches.clientWidth,
          stripScrollWidth: paintSwatches.scrollWidth,
          stripRight: paintSwatchesRect.right,
          gridColumnGap: paintSwatchesStyle.columnGap,
          gridRowGap: paintSwatchesStyle.rowGap,
          lastRight: sampleFiveRect.right,
          adjacentGap: sampleOneRect.left - sampleZeroRect.right,
          toolGapAfterSamples: eraserRect.left - sampleFiveRect.right,
          toolGapBetweenButtons: clearRect.left - eraserRect.right,
          labelDisplay: getComputedStyle(sampleName).display,
          swatchBackground: getComputedStyle(sampleSwatch).backgroundColor,
          swatchWidth: sampleSwatchRect.width,
          swatchHeight: sampleSwatchRect.height,
          actionLineBackgroundSize:
            getComputedStyle(sampleAction, "::after").backgroundSize,
          actionLineBackgroundPosition:
            getComputedStyle(sampleAction, "::after").backgroundPosition,
          finalActionLineBackgroundSize:
            getComputedStyle(sampleFiveAction, "::after").backgroundSize,
          finalActionLineBackgroundPosition:
            getComputedStyle(sampleFiveAction, "::after").backgroundPosition,
          uploadBackground: getComputedStyle(sampleUpload).backgroundColor,
          uploadWidth: sampleUploadRect.width,
          uploadHeight: sampleUploadRect.height,
          uploadIconWidth: sampleUploadIconRect.width,
          uploadIconHeight: sampleUploadIconRect.height,
          uploadTop: sampleUploadRect.top,
          uploadBottom: sampleUploadRect.bottom,
          buttonWidth: sampleZeroRect.width,
          buttonHeight: sampleZeroRect.height
        },
        tools: {
          eraserText: eraserLabel.textContent,
          clearText: clearLabel.textContent,
          eraserLabelDisplay: getComputedStyle(eraserLabel).display,
          clearLabelDisplay: getComputedStyle(clearLabel).display,
          eraserIconDisplay: getComputedStyle(eraserIcon).display,
          clearIconDisplay: getComputedStyle(clearIcon).display,
          eraserIconStrokeWidth: getComputedStyle(eraserIcon).strokeWidth,
          clearIconStrokeWidth: getComputedStyle(clearIcon).strokeWidth,
          eraserWidth: eraserRect.width,
          eraserHeight: eraserRect.height,
          eraserLeft: eraserRect.left,
          eraserRight: eraserRect.right,
          eraserTop: eraserRect.top,
          clearWidth: clearRect.width,
          clearHeight: clearRect.height,
          clearLeft: clearRect.left,
          clearTop: clearRect.top
        }
      };
    });

    expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewportWidth + 2);
    expect(layout.pageHeight).toBeLessThanOrEqual(layout.viewportHeight + 2);
    expect(layout.canvas.width).toBeGreaterThan(viewport.width < 500 ? 360 : 520);
    expect(Math.abs(layout.canvas.width - layout.canvas.height)).toBeLessThan(2);
    expect(layout.playButton.text).toBe("");
    expect(layout.playButton.inTurntableVisual).toBe(true);
    expect(layout.playButton.inTransportControls).toBe(false);
    expect(Math.abs(layout.playButton.width - layout.playButton.height)).toBeLessThan(1);
    expect(layout.playButton.width).toBeGreaterThan(layout.canvas.width * 0.12);
    expect(layout.playButton.width).toBeLessThan(layout.canvas.width * 0.2);
    expect(
      Math.abs(layout.playButton.centerX - layout.playButton.visualCenterX)
    ).toBeLessThan(2);
    expect(
      Math.abs(layout.playButton.centerY - layout.playButton.visualCenterY)
    ).toBeLessThan(2);
    expect(layout.playButton.playIconDisplay).toBe("block");
    expect(layout.playButton.pauseIconDisplay).toBe("none");
    expect(layout.playButton.ariaLabel).toBe("Play");
    expect(layout.playButton.ariaPressed).toBe("false");

    if (viewport.width <= 620) {
      expect(layout.paint.width).toBeGreaterThanOrEqual(layout.viewportWidth - 14);
      expect(layout.transport.width).toBeGreaterThanOrEqual(
        layout.viewportWidth - 14
      );
      expect(layout.paint.paddingLeft).toBeGreaterThanOrEqual(16);
      expect(layout.paint.paddingRight).toBeGreaterThanOrEqual(16);
      expect(layout.paint.paddingTop).toBeGreaterThanOrEqual(6);
      expect(layout.paint.paddingBottom).toBeGreaterThanOrEqual(6);
      expect(layout.transport.paddingLeft).toBeGreaterThanOrEqual(16);
      expect(layout.transport.paddingRight).toBeGreaterThanOrEqual(16);
      expect(layout.transport.paddingTop).toBeGreaterThanOrEqual(6);
      expect(layout.transport.paddingBottom).toBeGreaterThanOrEqual(6);
      expect(layout.paint.paddingTop - layout.paint.paddingBottom).toBe(8);
      expect(layout.transport.paddingBottom - layout.transport.paddingTop).toBe(8);
      expect(layout.paint.paddingTop - layout.paint.paddingBottom).toBe(
        layout.transport.paddingBottom - layout.transport.paddingTop
      );
      expect(layout.paint.bottom).toBeLessThanOrEqual(layout.canvas.top + 2);
      expect(layout.transport.top).toBeGreaterThanOrEqual(layout.canvas.bottom - 2);
      expect(layout.speedSlider.width).toBeGreaterThan(
        layout.speedSlider.height * 3
      );
      expect(layout.speedSlider.thumbAtMinimum.left).toBeGreaterThanOrEqual(0);
      expect(layout.speedSlider.thumbAtMaximum.right).toBeLessThanOrEqual(
        layout.viewportWidth
      );
      expect(Math.abs(layout.samples.firstTop - layout.samples.lastTop)).toBeLessThan(
        2
      );
      expect(layout.samples.lastLeft).toBeGreaterThan(layout.samples.firstLeft);
      expect(layout.samples.gridColumnGap).toBe("0px");
      expect(layout.samples.gridRowGap).toBe("0px");
      expect(Math.abs(layout.samples.adjacentGap)).toBeLessThan(1);
      expect(Math.abs(layout.samples.toolGapAfterSamples - 6)).toBeLessThan(1);
      expect(Math.abs(layout.samples.toolGapBetweenButtons - 4)).toBeLessThan(1);
      expect(layout.samples.stripScrollWidth).toBeLessThanOrEqual(
        layout.samples.stripClientWidth + 1
      );
      expect(layout.samples.labelDisplay).toBe("none");
      expect(layout.samples.swatchBackground).not.toBe("rgb(255, 255, 255)");
      expect(layout.samples.swatchWidth).toBeGreaterThan(16);
      expect(Math.abs(layout.samples.swatchHeight - layout.tools.eraserHeight)).toBeLessThan(1);
      expect(layout.samples.uploadBackground).toBe("rgb(255, 128, 0)");
      expect(Math.abs(layout.samples.uploadWidth - layout.samples.buttonWidth)).toBeLessThan(1);
      expect(Math.abs(layout.samples.uploadHeight - layout.samples.swatchHeight / 2)).toBeLessThan(1);
      expect(layout.samples.uploadIconWidth).toBeGreaterThan(8);
      expect(Math.abs(layout.samples.uploadIconWidth - layout.samples.uploadIconHeight)).toBeLessThan(1);
      expect(layout.samples.uploadTop).toBeGreaterThan(layout.samples.firstTop);
      expect(Math.abs(layout.samples.uploadBottom - (layout.samples.firstTop + layout.samples.buttonHeight))).toBeLessThan(1);
      expect(layout.samples.actionLineBackgroundSize).toBe("2.55px 100%");
      expect(layout.samples.actionLineBackgroundPosition).toBe("0% 50%");
      expect(layout.samples.finalActionLineBackgroundSize).toBe("2.55px 100%, 2.55px 100%");
      expect(layout.samples.finalActionLineBackgroundPosition).toBe("0% 50%, 100% 50%");
      expect(layout.tools.eraserText).toBe("Eraser");
      expect(layout.tools.clearText).toBe("Clear");
      expect(layout.tools.eraserLabelDisplay).toBe("none");
      expect(layout.tools.clearLabelDisplay).toBe("none");
      expect(layout.tools.eraserIconDisplay).toBe("block");
      expect(layout.tools.clearIconDisplay).toBe("block");
      expect(layout.tools.eraserIconStrokeWidth).toBe("2px");
      expect(layout.tools.clearIconStrokeWidth).toBe("2px");
      expect(Math.abs(layout.tools.eraserWidth - layout.samples.buttonWidth)).toBeLessThan(1);
      expect(Math.abs(layout.tools.clearWidth - layout.samples.buttonWidth)).toBeLessThan(1);
      expect(Math.abs(layout.samples.buttonHeight - layout.tools.eraserHeight * 1.5)).toBeLessThan(1);
      expect(Math.abs(layout.tools.eraserHeight - 42)).toBeLessThan(1);
      expect(Math.abs(layout.tools.clearHeight - layout.tools.eraserHeight)).toBeLessThan(1);
      expect(Math.abs(layout.tools.eraserTop - layout.samples.firstTop)).toBeLessThan(2);
      expect(Math.abs(layout.tools.clearTop - layout.samples.firstTop)).toBeLessThan(2);
      expect(layout.tools.eraserLeft).toBeGreaterThan(layout.samples.lastRight);
      expect(layout.tools.clearLeft).toBeGreaterThan(layout.tools.eraserRight);
    } else {
      const canvasCenterY = (layout.canvas.top + layout.canvas.bottom) / 2;
      const sliderCenterY =
        (layout.speedSlider.top + layout.speedSlider.bottom) / 2;

      expect(layout.paint.width).toBeLessThanOrEqual(
        viewport.width < 1100 ? 125 : 165
      );
      expect(layout.paint.right).toBeLessThanOrEqual(layout.canvas.left + 2);
      expect(layout.transport.left).toBeGreaterThanOrEqual(
        layout.canvas.right - 2
      );
      expect(Math.abs(sliderCenterY - canvasCenterY)).toBeLessThanOrEqual(3);
      expect(layout.tools.eraserLabelDisplay).not.toBe("none");
      expect(layout.tools.clearLabelDisplay).not.toBe("none");
      expect(layout.tools.eraserIconDisplay).toBe("none");
      expect(layout.tools.clearIconDisplay).toBe("none");
      expect(Math.abs(layout.tools.eraserWidth - layout.samples.buttonWidth)).toBeLessThan(1);
      expect(Math.abs(layout.tools.clearWidth - layout.samples.buttonWidth)).toBeLessThan(1);
      expect(layout.samples.buttonHeight).toBeLessThan(90);
      expect(Math.abs(layout.tools.eraserHeight - layout.samples.buttonHeight)).toBeLessThan(1);
      expect(Math.abs(layout.tools.clearHeight - layout.samples.buttonHeight)).toBeLessThan(1);
      expect(Math.abs(layout.samples.firstTop - layout.speedSlider.top)).toBeLessThan(3);
      expect(
        Math.abs(
          layout.tools.clearTop + layout.tools.clearHeight - layout.speedSlider.bottom
        )
      ).toBeLessThan(3);
      expect(
        Math.abs(
          layout.tools.clearTop +
            layout.tools.clearHeight -
            layout.samples.firstTop -
            layout.speedSlider.height
        )
      ).toBeLessThan(3);
    }

    for (const item of [layout.canvas, layout.paint, layout.transport]) {
      expect(item.width).toBeGreaterThan(0);
      expect(item.height).toBeGreaterThan(0);
      expect(item.left).toBeGreaterThanOrEqual(-2);
      expect(item.right).toBeLessThanOrEqual(layout.viewportWidth + 2);
    }
  }
});

test("loads only same-origin runtime resources in isolated production preview", async ({ page }) => {
  await page.goto("/");

  const crossOriginResources = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => new URL(name).origin !== window.location.origin)
  );

  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
  expect(crossOriginResources).toEqual([]);
});
