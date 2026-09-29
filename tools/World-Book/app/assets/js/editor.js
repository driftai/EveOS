(function () {
  const WB = window.WorldBook;

  WB.Editor = {
    init(elements, callbacks) {
      this.el = elements;
      this.callbacks = callbacks;
      this.taxonomyState = null;

      this.tagInline = new WB.EntryTagInline({
        chips: elements.tagChips,
        input: elements.tagInput,
        suggestions: elements.tagSuggestions,
        summary: elements.tagSummary,
        getDefinitions: () => this.taxonomyState ? this.taxonomyState.tagDefinitions : [],
        onCreate: name => callbacks.onCreateTag(name),
        onAdd: callbacks.onAddTag,
        onHide: callbacks.onHideTag
      });

      this.linkPanel = new WB.LinkPanel({
        section: elements.linksSection,
        list: elements.linkList,
        add: elements.addLink,
        back: elements.linkBack,
        count: elements.linkCount,
        toggle: elements.toggleLinks,
        filter: elements.linkDirectionFilter
      }, {
        onAdd: callbacks.onAddLink,
        onBack: callbacks.onLinkBack,
        onOpen: callbacks.onOpenLink,
        onEdit: callbacks.onEditLink,
        onRemove: callbacks.onRemoveLink,
        onToggle: callbacks.onToggleLinks,
        onDirectionChange: callbacks.onLinkDirectionChange
      });

      elements.name.addEventListener("change", () => callbacks.onRename(elements.name.value));
      elements.status.addEventListener("change", () => callbacks.onMetaChange({ status: elements.status.value }));
      elements.notes.addEventListener("input", () => callbacks.onMetaChange({ notes: elements.notes.value, refreshTags: true }));
      elements.manageTags.addEventListener("click", callbacks.onManageEntryTags);
      elements.manageStatuses.addEventListener("click", callbacks.onManageStatuses);
      elements.moveVirtual.addEventListener("click", callbacks.onMoveVirtual);
      elements.copyToWorldBook.addEventListener("click", callbacks.onCopyToWorldBook);
      elements.exportZipToLive.addEventListener("click", callbacks.onExportZipToLive);
      elements.saveFile.addEventListener("click", () => callbacks.onSaveFile(elements.fileContent.value));
      elements.open.addEventListener("click", callbacks.onOpen);
      elements.reveal.addEventListener("click", callbacks.onReveal);
      elements.deleteVirtual.addEventListener("click", callbacks.onDeleteVirtual);
    },

    hide(title, message) {
      this.el.panel.hidden = true;
      this.el.empty.hidden = false;
      this.el.empty.querySelector("h2").textContent = title || "Select an entry";
      this.el.empty.querySelector("p").textContent = message || "Choose something from the tree.";
    },

    renderStatuses(currentStatus, disabled) {
      this.el.status.innerHTML = "";
      const definitions = this.taxonomyState ? this.taxonomyState.statusDefinitions : [];
      definitions.forEach(definition => {
        const option = document.createElement("option");
        option.value = definition.id;
        option.textContent = definition.name;
        this.el.status.appendChild(option);
      });
      if (currentStatus && !definitions.some(item => item.id === currentStatus)) {
        const option = document.createElement("option");
        option.value = currentStatus;
        option.textContent = currentStatus;
        this.el.status.appendChild(option);
      }
      this.el.status.value = currentStatus || definitions[0]?.id || "draft";
      this.el.status.disabled = Boolean(disabled);
    },

    prepareTaxonomy(state, status, tagInfo, disabled) {
      this.taxonomyState = state;
      this.renderStatuses(status, disabled);
      this.tagInline.setData(tagInfo, disabled);
      this.el.manageTags.hidden = Boolean(disabled);
      this.el.manageStatuses.hidden = Boolean(disabled);
    },

    renderLinks(state, links, disabled) {
      this.linkPanel.render(state, links || [], {
        disabled: Boolean(disabled),
        backLabel: this.callbacks.getLinkBackLabel(),
        collapsed: this.callbacks.getLinksCollapsed(),
        direction: this.callbacks.getLinkDirection()
      });
    },

    refreshTaxonomy(state, status, tagInfo, disabled) {
      this.prepareTaxonomy(state, status, tagInfo, Boolean(disabled));
    },

    refreshLinks(state, links, disabled) {
      this.renderLinks(state, links, disabled);
    },

    showBase() {
      this.el.empty.hidden = true;
      this.el.panel.hidden = false;
      this.el.fileSection.hidden = true;
      this.el.open.hidden = true;
      this.el.reveal.hidden = true;
      this.el.moveVirtual.hidden = true;
      this.el.copyToWorldBook.hidden = true;
      this.el.exportZipToLive.hidden = true;
      this.el.saveFile.hidden = true;
      this.el.deleteVirtual.hidden = true;
      this.el.name.disabled = false;
      this.el.notes.disabled = false;
    },

    showPhysical(entry, meta, contentPayload, taxonomyState, tagInfo) {
      this.showBase();
      this.prepareTaxonomy(taxonomyState, meta.status || "draft", tagInfo, false);
      this.renderLinks(taxonomyState, meta.links || [], false);
      this.el.name.value = entry.name;
      this.el.kind.textContent = entry.kind;
      this.el.path.textContent = entry.relativePath || "(workspace root)";
      this.el.breadcrumb.textContent = entry.relativePath ? entry.relativePath.split("/").join(" › ") : "Live workspace";
      this.el.notes.value = meta.notes || "";
      this.el.modified.textContent = entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : "—";
      this.el.metaUpdated.textContent = meta.updatedAt ? new Date(meta.updatedAt).toLocaleString() : "—";
      this.el.size.textContent = entry.size == null ? "—" : `${Number(entry.size).toLocaleString()} bytes`;
      this.el.source.textContent = "Physical workspace";
      this.el.open.hidden = false;
      this.el.reveal.hidden = false;
      this.el.copyToWorldBook.hidden = false;

      if (entry.kind === "file" && contentPayload) {
        this.el.fileSection.hidden = false;
        this.el.contentTitle.textContent = entry.name;
        this.el.contentHelp.textContent = contentPayload.editable
          ? "Editing here writes directly to the physical text file."
          : "Preview only. Open externally to edit the original file.";
        this.el.contentFormat.textContent = contentPayload.format || entry.extension || "file";
        this.el.fileContent.value = contentPayload.content || "";
        this.el.fileContent.readOnly = !contentPayload.editable;
        this.el.saveFile.hidden = !contentPayload.editable;
      }
      this.callbacks.onEntryRendered?.();
    },

    showVirtual(node, path, taxonomyState, tagInfo) {
      this.showBase();
      this.prepareTaxonomy(taxonomyState, node.status || "draft", tagInfo, false);
      this.renderLinks(taxonomyState, WB.Links.forEntry(taxonomyState, node.id), false);
      this.el.name.value = node.name;
      this.el.kind.textContent = `virtual ${node.type}`;
      this.el.path.textContent = "World Book database";
      this.el.breadcrumb.textContent = path.map(item => item.name).join(" › ");
      this.el.notes.value = node.content || "";
      this.el.modified.textContent = node.updatedAt ? new Date(node.updatedAt).toLocaleString() : "—";
      this.el.metaUpdated.textContent = node.updatedAt ? new Date(node.updatedAt).toLocaleString() : "—";
      this.el.size.textContent = "—";
      this.el.source.textContent = "Virtual World Book";
      this.el.moveVirtual.hidden = node.id === "root";
      this.el.exportZipToLive.hidden = false;
      this.el.deleteVirtual.hidden = node.id === "root";
      this.callbacks.onEntryRendered?.();
    },

    showSnapshot(node, record, taxonomyState) {
      this.showBase();
      const snapshotTags = node.effectiveTags || node.tags || [];
      this.prepareTaxonomy(
        taxonomyState,
        node.status || "recovered",
        WB.Taxonomy.simpleTagInfo(snapshotTags, snapshotTags),
        true
      );
      this.renderLinks(taxonomyState, node.links || [], true);
      this.el.name.value = node.name;
      this.el.name.disabled = true;
      this.el.kind.textContent = `snapshot ${node.kind}`;
      this.el.path.textContent = node.relativePath || record.sourceRootPath || "Imported snapshot";
      this.el.breadcrumb.textContent = `${record.name} › ${node.relativePath || node.name}`;
      this.el.notes.value = node.notes || "Imported snapshots are read-only and never overwrite the live workspace.";
      this.el.notes.disabled = true;
      this.el.modified.textContent = node.modifiedAt ? new Date(node.modifiedAt).toLocaleString() : "—";
      this.el.metaUpdated.textContent = node.metaUpdatedAt ? new Date(node.metaUpdatedAt).toLocaleString() : "—";
      this.el.size.textContent = node.size == null ? "—" : `${Number(node.size).toLocaleString()} bytes`;
      this.el.source.textContent = "Imported JSON snapshot";

      if (node.kind === "file" && Object.prototype.hasOwnProperty.call(node, "content")) {
        this.el.fileSection.hidden = false;
        this.el.contentTitle.textContent = node.name;
        this.el.contentHelp.textContent = "Read-only content captured when the snapshot was exported.";
        this.el.contentFormat.textContent = node.contentFormat || node.extension || "file";
        this.el.fileContent.value = node.content || "";
        this.el.fileContent.readOnly = true;
      }
      this.callbacks.onEntryRendered?.();
    }
  };
})();
