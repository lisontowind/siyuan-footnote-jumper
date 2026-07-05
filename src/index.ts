import {Menu, Plugin, showMessage} from "siyuan";
import "./index.scss";

const STORAGE_NAME = "footnote-jumper-settings";
const ENHANCED_ATTR = "data-siyuan-footnote-enhanced";
const REF_CLASS = "siyuan-footnote-ref";
const DEF_CLASS = "siyuan-footnote-definition";
const HIGHLIGHT_CLASS = "siyuan-footnote-definition--highlight";
const MISSING_CLASS = "siyuan-footnote-ref--missing";
const TOOLTIP_CLASS = "siyuan-footnote-tooltip";
const TOOLTIP_VISIBLE_CLASS = "siyuan-footnote-tooltip--visible";

interface FootnoteSettings {
    enabled: boolean;
}

interface FootnoteDefinition {
    id: string;
    content: string;
    element: HTMLElement;
}

export default class FootnoteJumperPlugin extends Plugin {
    private enabled = true;
    private topBarElement?: HTMLElement;
    private observer?: MutationObserver;
    private refreshTimer = 0;
    private isRendering = false;
    private definitions = new Map<string, FootnoteDefinition>();
    private tooltipElement?: HTMLElement;
    private activeTooltipRef?: HTMLElement;

    private readonly handleDocumentClick = (event: MouseEvent) => {
        if (!this.enabled) {
            return;
        }

        const target = event.target as HTMLElement;
        const refElement = target?.closest?.(`.${REF_CLASS}`) as HTMLElement;
        if (!refElement) {
            return;
        }

        const id = refElement.dataset.footnoteId;
        if (!id) {
            return;
        }

        const definition = this.findDefinition(id, refElement);
        if (!definition) {
            showMessage(`未找到脚注 [^${id}] 的定义`);
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        definition.element.scrollIntoView({
            behavior: "smooth",
            block: "center",
        });
        definition.element.classList.remove(HIGHLIGHT_CLASS);
        window.setTimeout(() => definition.element.classList.add(HIGHLIGHT_CLASS), 30);
        window.setTimeout(() => definition.element.classList.remove(HIGHLIGHT_CLASS), 1800);
    };

    private readonly handleBeforeEdit = (event: Event) => {
        if (!this.enabled || this.isRendering) {
            return;
        }

        const target = event.target as HTMLElement;
        if (!target?.closest?.(".protyle-wysiwyg")) {
            return;
        }

        this.cleanupEnhancements();
        this.scheduleRefresh(600);
    };

    private readonly handlePointerOver = (event: PointerEvent) => {
        if (!this.enabled) {
            return;
        }

        const refElement = this.getReferenceElement(event.target);
        if (!refElement) {
            return;
        }

        this.activeTooltipRef = refElement;
        this.showTooltip(refElement);
    };

    private readonly handlePointerMove = () => {
        if (!this.enabled || !this.activeTooltipRef) {
            return;
        }

        this.positionTooltip(this.activeTooltipRef);
    };

    private readonly handlePointerOut = (event: PointerEvent) => {
        const refElement = this.getReferenceElement(event.target);
        if (!refElement) {
            return;
        }

        const nextTarget = event.relatedTarget as HTMLElement | null;
        if (nextTarget && refElement.contains(nextTarget)) {
            return;
        }

        this.hideTooltip();
    };

    private readonly handleViewportChange = () => {
        if (!this.enabled || !this.activeTooltipRef) {
            return;
        }

        if (!document.body.contains(this.activeTooltipRef)) {
            this.hideTooltip();
            return;
        }

        this.positionTooltip(this.activeTooltipRef);
    };

    onload() {
        this.addIcons(`
            <symbol id="iconFootnoteJumper" viewBox="0 0 32 32">
                <path d="M8 5h16v4H14v5h8v4h-8v9H8V5z"></path>
                <path d="M22 18h3v3h3v3h-3v3h-3v-3h-3v-3h3v-3z"></path>
            </symbol>
        `);
    }

    async onLayoutReady() {
        await this.loadSettings();
        this.topBarElement = this.addTopBar({
            icon: "iconFootnoteJumper",
            title: "脚注跳转",
            position: "right",
            callback: (event) => this.openTopBarMenu(event),
        });
        this.updateTopBarState();

        document.addEventListener("click", this.handleDocumentClick, true);
        document.addEventListener("pointerover", this.handlePointerOver, true);
        document.addEventListener("pointermove", this.handlePointerMove, true);
        document.addEventListener("pointerout", this.handlePointerOut, true);
        document.addEventListener("beforeinput", this.handleBeforeEdit, true);
        document.addEventListener("compositionstart", this.handleBeforeEdit, true);
        document.addEventListener("scroll", this.handleViewportChange, true);
        window.addEventListener("resize", this.handleViewportChange);

        this.observer = new MutationObserver(() => {
            if (!this.enabled || this.isRendering) {
                return;
            }
            this.scheduleRefresh();
        });
        this.observer.observe(document.body, {
            childList: true,
            characterData: true,
            subtree: true,
        });

        if (this.enabled) {
            this.scheduleRefresh(100);
        }
    }

    onunload() {
        window.clearTimeout(this.refreshTimer);
        this.observer?.disconnect();
        document.removeEventListener("click", this.handleDocumentClick, true);
        document.removeEventListener("pointerover", this.handlePointerOver, true);
        document.removeEventListener("pointermove", this.handlePointerMove, true);
        document.removeEventListener("pointerout", this.handlePointerOut, true);
        document.removeEventListener("beforeinput", this.handleBeforeEdit, true);
        document.removeEventListener("compositionstart", this.handleBeforeEdit, true);
        document.removeEventListener("scroll", this.handleViewportChange, true);
        window.removeEventListener("resize", this.handleViewportChange);
        this.destroyTooltip();
        this.cleanupEnhancements();
    }

    private async loadSettings() {
        try {
            const settings = await this.loadData(STORAGE_NAME) as FootnoteSettings;
            if (typeof settings?.enabled === "boolean") {
                this.enabled = settings.enabled;
            }
        } catch (error) {
            console.warn(`[${this.name}] load settings failed`, error);
        }
    }

    private saveSettings() {
        const settings: FootnoteSettings = {
            enabled: this.enabled,
        };
        this.saveData(STORAGE_NAME, settings).catch((error) => {
            console.warn(`[${this.name}] save settings failed`, error);
        });
    }

    private openTopBarMenu(event: MouseEvent) {
        event.preventDefault();
        event.stopPropagation();

        const menu = new Menu("siyuan-footnote-jumper-menu");
        menu.addItem({
            label: "脚注跳转",
            icon: "iconFootnoteJumper",
            checked: this.enabled,
            click: () => {
                this.setEnabled(!this.enabled);
            },
        });

        const rect = this.topBarElement?.getBoundingClientRect();
        menu.open({
            x: rect ? rect.left : event.clientX,
            y: rect ? rect.bottom : event.clientY,
        });
    }

    private setEnabled(enabled: boolean) {
        if (this.enabled === enabled) {
            return;
        }

        this.enabled = enabled;
        this.updateTopBarState();
        this.saveSettings();

        if (this.enabled) {
            this.scheduleRefresh(50);
            showMessage("脚注跳转已开启");
        } else {
            this.hideTooltip();
            this.cleanupEnhancements();
            showMessage("脚注跳转已关闭");
        }
    }

    private updateTopBarState() {
        if (!this.topBarElement) {
            return;
        }

        this.topBarElement.classList.toggle("siyuan-footnote-topbar--enabled", this.enabled);
        this.topBarElement.setAttribute("aria-pressed", String(this.enabled));
        this.topBarElement.setAttribute("aria-label", "脚注跳转");
        this.topBarElement.removeAttribute("title");
    }

    private scheduleRefresh(delay = 250) {
        window.clearTimeout(this.refreshTimer);
        this.refreshTimer = window.setTimeout(() => this.refresh(), delay);
    }

    private refresh() {
        if (!this.enabled) {
            return;
        }

        this.isRendering = true;
        try {
            this.cleanupEnhancements();
            this.definitions.clear();

            const editors = Array.from(document.querySelectorAll<HTMLElement>(".protyle-wysiwyg"));
            for (const editor of editors) {
                const definitions = this.collectDefinitions(editor);
                this.wrapReferences(editor, definitions);
            }
        } finally {
            this.isRendering = false;
        }
    }

    private collectDefinitions(root: HTMLElement) {
        const definitions = new Map<string, FootnoteDefinition>();
        const blocks = Array.from(root.querySelectorAll<HTMLElement>("[data-node-id]"));

        for (const block of blocks) {
            const text = this.getVisibleText(block).trim();
            const match = text.match(/^\[\^([^\]\s:]+)\]:\s*([\s\S]*)$/);
            if (!match) {
                continue;
            }

            const definition: FootnoteDefinition = {
                id: match[1],
                content: match[2].trim() || "空脚注",
                element: block,
            };
            block.classList.add(DEF_CLASS);
            block.dataset.footnoteId = definition.id;
            definitions.set(definition.id, definition);
            this.definitions.set(definition.id, definition);
        }

        return definitions;
    }

    private wrapReferences(root: HTMLElement, definitions: Map<string, FootnoteDefinition>) {
        const textNodes: Text[] = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => this.acceptReferenceTextNode(node),
        });

        while (walker.nextNode()) {
            textNodes.push(walker.currentNode as Text);
        }

        for (const textNode of textNodes) {
            this.wrapReferenceTextNode(textNode, definitions);
        }
    }

    private acceptReferenceTextNode(node: Node) {
        const text = node.textContent || "";
        if (!text.includes("[^")) {
            return NodeFilter.FILTER_REJECT;
        }

        const parent = node.parentElement;
        if (!parent) {
            return NodeFilter.FILTER_REJECT;
        }

        if (parent.closest(`.${REF_CLASS}, .${DEF_CLASS}, [${ENHANCED_ATTR}], style, script, textarea, input`)) {
            return NodeFilter.FILTER_REJECT;
        }

        if (!parent.closest(".protyle-wysiwyg")) {
            return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
    }

    private wrapReferenceTextNode(textNode: Text, definitions: Map<string, FootnoteDefinition>) {
        const text = textNode.nodeValue || "";
        const regex = /\[\^([^\]\s:]+)\]/g;
        let match: RegExpExecArray | null;
        let lastIndex = 0;
        const fragment = document.createDocumentFragment();
        let changed = false;

        while ((match = regex.exec(text)) !== null) {
            changed = true;
            const [raw, id] = match;
            if (match.index > lastIndex) {
                fragment.append(document.createTextNode(text.slice(lastIndex, match.index)));
            }

            const definition = definitions.get(id);
            const refElement = document.createElement("span");
            refElement.className = definition ? REF_CLASS : `${REF_CLASS} ${MISSING_CLASS}`;
            refElement.textContent = raw;
            refElement.dataset.footnoteId = id;
            refElement.dataset.preview = definition ? definition.content : "未找到对应脚注定义";
            refElement.setAttribute(ENHANCED_ATTR, "true");
            refElement.setAttribute("contenteditable", "false");
            fragment.append(refElement);

            lastIndex = match.index + raw.length;
        }

        if (!changed) {
            return;
        }

        if (lastIndex < text.length) {
            fragment.append(document.createTextNode(text.slice(lastIndex)));
        }
        textNode.parentNode?.replaceChild(fragment, textNode);
    }

    private cleanupEnhancements() {
        this.hideTooltip();
        const previousRenderingState = this.isRendering;
        this.isRendering = true;
        try {
            const refs = Array.from(document.querySelectorAll<HTMLElement>(`.${REF_CLASS}[${ENHANCED_ATTR}]`));
            for (const ref of refs) {
                const parent = ref.parentNode;
                if (!parent) {
                    continue;
                }
                parent.replaceChild(document.createTextNode(ref.textContent || ""), ref);
                parent.normalize();
            }

            const definitions = Array.from(document.querySelectorAll<HTMLElement>(`.${DEF_CLASS}`));
            for (const definition of definitions) {
                definition.classList.remove(DEF_CLASS, HIGHLIGHT_CLASS);
                delete definition.dataset.footnoteId;
            }
        } finally {
            this.isRendering = previousRenderingState;
        }
    }

    private findDefinition(id: string, refElement: HTMLElement) {
        const editor = refElement.closest(".protyle-wysiwyg");
        const localDefinition = editor
            ? Array.from(editor.querySelectorAll<HTMLElement>(`.${DEF_CLASS}`)).find((item) => item.dataset.footnoteId === id)
            : undefined;

        if (localDefinition) {
            return {
                id,
                content: this.getVisibleText(localDefinition).trim(),
                element: localDefinition,
            };
        }

        return this.definitions.get(id);
    }

    private getVisibleText(element: HTMLElement) {
        return (element.innerText || element.textContent || "").replace(/\u00a0/g, " ");
    }

    private getReferenceElement(target: EventTarget | null) {
        if (!(target instanceof HTMLElement)) {
            return undefined;
        }

        return target.closest(`.${REF_CLASS}`) as HTMLElement | null || undefined;
    }

    private showTooltip(refElement: HTMLElement) {
        const text = refElement.dataset.preview;
        if (!text) {
            this.hideTooltip();
            return;
        }

        refElement.removeAttribute("title");
        refElement.removeAttribute("aria-label");
        const tooltip = this.ensureTooltip();
        tooltip.textContent = text;
        tooltip.classList.add(TOOLTIP_VISIBLE_CLASS);
        this.positionTooltip(refElement);
    }

    private ensureTooltip() {
        if (this.tooltipElement) {
            return this.tooltipElement;
        }

        const tooltip = document.createElement("div");
        tooltip.className = TOOLTIP_CLASS;
        tooltip.setAttribute("role", "tooltip");
        document.body.append(tooltip);
        this.tooltipElement = tooltip;
        return tooltip;
    }

    private positionTooltip(refElement: HTMLElement) {
        const tooltip = this.tooltipElement;
        if (!tooltip) {
            return;
        }

        const margin = 12;
        const gap = 10;
        const refRect = refElement.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        const maxLeft = Math.max(margin, window.innerWidth - tooltipRect.width - margin);
        const preferredLeft = refRect.left + refRect.width / 2 - tooltipRect.width / 2;
        const left = Math.min(Math.max(preferredLeft, margin), maxLeft);

        let top = refRect.top - tooltipRect.height - gap;
        if (top < margin) {
            top = refRect.bottom + gap;
        }

        const maxTop = Math.max(margin, window.innerHeight - tooltipRect.height - margin);
        top = Math.min(Math.max(top, margin), maxTop);

        tooltip.style.left = `${Math.round(left)}px`;
        tooltip.style.top = `${Math.round(top)}px`;
    }

    private hideTooltip() {
        this.activeTooltipRef = undefined;
        this.tooltipElement?.classList.remove(TOOLTIP_VISIBLE_CLASS);
    }

    private destroyTooltip() {
        this.tooltipElement?.remove();
        this.tooltipElement = undefined;
        this.activeTooltipRef = undefined;
    }
}
