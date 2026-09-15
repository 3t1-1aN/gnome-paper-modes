import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const MODES = [
    {id: 'regular', label: 'Regular', icon: 'image-x-generic-symbolic'},
    {id: 'ink', label: 'Ink', icon: 'x-office-document-symbolic'},
    {id: 'color-paper', label: 'Color paper', icon: 'document-edit-symbolic'},
];

export class PaperIndicator {
    constructor(extension) {
        this._extension = extension;
        this._items = {};
        this._icon = new St.Icon({
            icon_name: 'x-office-document-symbolic',
            style_class: 'system-status-icon',
        });

        this.button = new PanelMenu.Button(0.0, 'Paper Modes', false);
        this.button.add_child(this._icon);
        this.button.accessible_name = 'Paper modes';

        for (const mode of MODES) {
            const item = new PopupMenu.PopupImageMenuItem(mode.label, mode.icon);
            item.connect('activate', () => this._extension.switchMode(mode.id));
            this.button.menu.addMenuItem(item);
            this._items[mode.id] = item;
        }

        Main.panel.addToStatusArea('paper-modes', this.button, 1, 'right');
    }

    setMode(mode) {
        const active = MODES.find(m => m.id === mode) ?? MODES[0];
        this._icon.icon_name = active.icon;
        this.button.accessible_name = `Paper modes: ${active.label}`;
        for (const [id, item] of Object.entries(this._items)) {
            item.setOrnament(id === active.id
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NONE);
        }
    }

    destroy() {
        this.button?.destroy();
        this.button = null;
        this._items = {};
        this._icon = null;
    }
}
