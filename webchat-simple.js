    // webchat-simple.js - Веб-чат с управляемым переключателем конфигураций

// ===============================================
// GDPR MANAGER CLASS
// ===============================================
class GDPRManager {
    constructor(chatInstance) {
        this.chat = chatInstance;
        this.config = chatInstance.config.gdpr || {};
        this.storagePrefix = this.config.advanced?.storagePrefix || 'nexusmind_gdpr_';
        this.consentKey = this.storagePrefix + 'consent';
        this.userDataKey = this.storagePrefix + 'user_data';
        this.preChatDataKey = this.storagePrefix + 'prechat_data';

        // Состояние
        this.consentGiven = false;
        this.consentDeclined = false;
        this.preChatCompleted = false;
        this.userData = {};

        // Проверяем сохраненное согласие при инициализации
        this.loadConsentState();
    }

    // ═══════════════════════════════════════════════════════════
    // УПРАВЛЕНИЕ СОГЛАСИЕМ
    // ═══════════════════════════════════════════════════════════

    isEnabled() {
        return this.config.enabled === true;
    }

    hasConsent() {
        return this.consentGiven && !this.isConsentExpired();
    }

    isConsentExpired() {
        try {
            const consentData = localStorage.getItem(this.consentKey);
            if (!consentData) return true;

            const data = JSON.parse(consentData);
            const expireDays = this.config.consentBanner?.expireDays || 365;
            const expiryDate = new Date(data.timestamp);
            expiryDate.setDate(expiryDate.getDate() + expireDays);

            return new Date() > expiryDate;
        } catch (e) {
            return true;
        }
    }

    loadConsentState() {
        try {
            const consentData = localStorage.getItem(this.consentKey);
            if (consentData) {
                const data = JSON.parse(consentData);
                if (!this.isConsentExpired()) {
                    this.consentGiven = data.accepted === true;
                    this.consentDeclined = data.accepted === false;
                }
            }

            // Загружаем данные pre-chat формы
            const preChatData = localStorage.getItem(this.preChatDataKey);
            if (preChatData) {
                this.userData = JSON.parse(preChatData);
                this.preChatCompleted = true;
            }
        } catch (e) {
            console.warn('GDPR: Ошибка загрузки состояния согласия:', e);
        }
    }

    saveConsent(accepted) {
        try {
            const consentData = {
                accepted: accepted,
                timestamp: new Date().toISOString(),
                privacyPolicyVersion: this.config.privacyPolicyVersion || '1.0',
                sessionId: this.chat.sessionId,
                domain: window.location.hostname
            };

            localStorage.setItem(this.consentKey, JSON.stringify(consentData));
            this.consentGiven = accepted;
            this.consentDeclined = !accepted;

            // Отправляем webhook если настроен
            this.sendConsentWebhook(consentData);

            return true;
        } catch (e) {
            console.error('GDPR: Ошибка сохранения согласия:', e);
            return false;
        }
    }

    revokeConsent() {
        try {
            // Очищаем все GDPR данные из localStorage
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith(this.storagePrefix)) {
                    keysToRemove.push(key);
                }
            }
            keysToRemove.forEach(key => localStorage.removeItem(key));

            this.consentGiven = false;
            this.consentDeclined = false;
            this.preChatCompleted = false;
            this.userData = {};

            return true;
        } catch (e) {
            console.error('GDPR: Ошибка отзыва согласия:', e);
            return false;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // PRE-CHAT ФОРМА
    // ═══════════════════════════════════════════════════════════

    isPreChatRequired() {
        return this.config.preChatForm?.enabled === true && !this.preChatCompleted;
    }

    savePreChatData(data) {
        try {
            this.userData = data;
            this.preChatCompleted = true;
            localStorage.setItem(this.preChatDataKey, JSON.stringify(data));

            // Отправляем webhook если настроен
            this.sendPreChatWebhook(data);

            return true;
        } catch (e) {
            console.error('GDPR: Ошибка сохранения данных формы:', e);
            return false;
        }
    }

    getUserData() {
        return this.userData;
    }

    // ═══════════════════════════════════════════════════════════
    // WEBHOOKS
    // ═══════════════════════════════════════════════════════════

    async sendWebhook(url, data) {
        if (!url) return null;

        const timeout = this.config.webhooks?.timeout || 10000;
        const retryAttempts = this.config.webhooks?.retryAttempts || 3;
        const retryDelay = this.config.webhooks?.retryDelay || 1000;

        for (let attempt = 0; attempt < retryAttempts; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeout);

                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(data),
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (response.ok) {
                    return await response.json();
                }
            } catch (e) {
                if (attempt < retryAttempts - 1) {
                    await new Promise(resolve => setTimeout(resolve, retryDelay * (attempt + 1)));
                }
            }
        }
        return null;
    }

    sendConsentWebhook(consentData) {
        const webhookUrl = this.config.webhooks?.consent;
        if (webhookUrl) {
            this.sendWebhook(webhookUrl, {
                action: 'consent_given',
                ...consentData
            });
        }
    }

    sendPreChatWebhook(formData) {
        const webhookUrl = this.config.webhooks?.preChatForm;
        if (webhookUrl) {
            this.sendWebhook(webhookUrl, {
                action: 'pre_chat_submit',
                sessionId: this.chat.sessionId,
                userData: formData,
                gdprConsent: true,
                timestamp: new Date().toISOString(),
                domain: window.location.hostname
            });
        }
    }

    async requestUserData() {
        const webhookUrl = this.config.webhooks?.dataAccess;
        if (!webhookUrl) return null;

        return await this.sendWebhook(webhookUrl, {
            action: 'view_data',
            sessionId: this.chat.sessionId,
            userEmail: this.userData.email
        });
    }

    async exportUserData() {
        const webhookUrl = this.config.webhooks?.dataExport;
        if (!webhookUrl) return null;

        return await this.sendWebhook(webhookUrl, {
            action: 'export_data',
            sessionId: this.chat.sessionId,
            userEmail: this.userData.email,
            format: this.config.privacyControls?.options?.exportData?.format || 'json'
        });
    }

    async deleteUserData() {
        const webhookUrl = this.config.webhooks?.dataDeletion;
        if (!webhookUrl) return null;

        const result = await this.sendWebhook(webhookUrl, {
            action: 'delete_data',
            sessionId: this.chat.sessionId,
            userEmail: this.userData.email,
            confirmDeletion: true
        });

        if (result) {
            // Очищаем локальные данные
            this.revokeConsent();
        }

        return result;
    }

    // ═══════════════════════════════════════════════════════════
    // РЕНДЕРИНГ UI КОМПОНЕНТОВ
    // ═══════════════════════════════════════════════════════════

    getTexts() {
        if (typeof this.chat.config.getTexts === 'function') {
            return this.chat.config.getTexts().gdpr || {};
        }
        return {};
    }

    renderConsentBanner() {
        if (!this.isEnabled() || !this.config.consentBanner?.enabled) return '';
        if (this.hasConsent() || this.consentDeclined) return '';

        const texts = this.getTexts();
        const position = this.config.consentBanner?.position || 'bottom';
        const showPrivacyLink = this.config.consentBanner?.showPrivacyLink && this.config.privacyPolicyUrl;
        const showCookieLink = this.config.consentBanner?.showCookieLink && this.config.cookiePolicyUrl;
        const showTermsLink = this.config.consentBanner?.showTermsLink && this.config.termsOfServiceUrl;
        const showDeclineButton = this.config.consentBanner?.showDeclineButton !== false;

        const customText = this.config.consentBanner?.customText;
        const mainText = customText || texts.consentText || 'We use this chat to process your requests.';
        const aiText = this.config.aiDisclosure?.enabled ? (texts.consentTextAI || '') : '';

        return `
            <div class="gdpr-consent-banner gdpr-position-${position}" id="gdprConsentBanner">
                <div class="gdpr-consent-content">
                    <div class="gdpr-consent-title">${texts.consentTitle || '🔒 Privacy & Cookies'}</div>
                    <div class="gdpr-consent-text">
                        ${mainText}
                        ${aiText ? `<br><br>${aiText}` : ''}
                    </div>
                    <div class="gdpr-consent-links">
                        ${showPrivacyLink ? `<a href="${this.config.privacyPolicyUrl}" target="_blank" class="gdpr-link">${texts.privacyLinkText || 'Privacy Policy'}</a>` : ''}
                        ${showCookieLink ? `<a href="${this.config.cookiePolicyUrl}" target="_blank" class="gdpr-link">${texts.cookieLinkText || 'Cookie Policy'}</a>` : ''}
                        ${showTermsLink ? `<a href="${this.config.termsOfServiceUrl}" target="_blank" class="gdpr-link">${texts.termsLinkText || 'Terms of Service'}</a>` : ''}
                    </div>
                    <div class="gdpr-consent-buttons">
                        <button class="gdpr-btn gdpr-btn-accept" id="gdprAcceptBtn">${texts.acceptButton || 'Accept & Continue'}</button>
                        ${showDeclineButton ? `<button class="gdpr-btn gdpr-btn-decline" id="gdprDeclineBtn">${texts.declineButton || 'Decline'}</button>` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    renderPreChatForm() {
        if (!this.isEnabled() || !this.config.preChatForm?.enabled) return '';
        if (this.preChatCompleted) return '';

        const texts = this.getTexts();
        const fields = this.config.preChatForm?.fields || [];

        let fieldsHTML = '';
        fields.forEach(field => {
            const label = texts[`${field.id}Label`] || field.id;
            const placeholder = texts[`${field.id}Placeholder`] || '';
            const requiredMark = field.required ? ' *' : '';
            const piiIcon = field.isPII ? `<span class="gdpr-pii-icon" title="${texts.piiIndicator || '🔒 Personal data'}">🔒</span>` : '';

            fieldsHTML += `
                <div class="gdpr-form-field">
                    <label class="gdpr-field-label">${label}${requiredMark} ${piiIcon}</label>
                    <input type="${field.type}"
                           name="${field.id}"
                           class="gdpr-field-input"
                           placeholder="${placeholder}"
                           ${field.required ? 'required' : ''}
                           ${field.validation?.minLength ? `minlength="${field.validation.minLength}"` : ''}
                           ${field.validation?.maxLength ? `maxlength="${field.validation.maxLength}"` : ''}
                           ${field.validation?.pattern ? `pattern="${field.validation.pattern}"` : ''}>
                </div>
            `;
        });

        const gdprCheckboxEnabled = this.config.preChatForm?.gdprCheckbox?.enabled !== false;
        const gdprCheckboxRequired = this.config.preChatForm?.gdprCheckbox?.required !== false;
        const linkToPrivacy = this.config.preChatForm?.gdprCheckbox?.linkToPrivacy && this.config.privacyPolicyUrl;

        const checkboxText = texts.gdprCheckboxText || 'I agree to the processing of my personal data';
        const checkboxHTML = gdprCheckboxEnabled ? `
            <div class="gdpr-form-field gdpr-checkbox-field">
                <label class="gdpr-checkbox-label">
                    <input type="checkbox" id="gdprFormCheckbox" ${gdprCheckboxRequired ? 'required' : ''}>
                    <span>${checkboxText}</span>
                    ${linkToPrivacy ? `<a href="${this.config.privacyPolicyUrl}" target="_blank" class="gdpr-link">${texts.privacyLinkText || 'Privacy Policy'}</a>` : ''}
                </label>
            </div>
        ` : '';

        return `
            <div class="gdpr-prechat-form" id="gdprPreChatForm">
                <div class="gdpr-form-content">
                    <div class="gdpr-form-title">${texts.formTitle || 'Start a Conversation'}</div>
                    <div class="gdpr-form-subtitle">${texts.formSubtitle || 'Please fill out the form before starting the chat'}</div>
                    <form id="gdprPreChatFormElement">
                        ${fieldsHTML}
                        ${checkboxHTML}
                        <div class="gdpr-form-info">${texts.requiredFieldMark || '* - required field'}</div>
                        <button type="submit" class="gdpr-btn gdpr-btn-submit">${texts.startChatButton || 'Start Chat'}</button>
                    </form>
                </div>
            </div>
        `;
    }

    renderDeclinedMessage() {
        if (!this.consentDeclined) return '';

        const texts = this.getTexts();
        return `
            <div class="gdpr-declined-message" id="gdprDeclinedMessage">
                <div class="gdpr-declined-content">
                    <div class="gdpr-declined-icon">🔒</div>
                    <div class="gdpr-declined-text">${texts.consentRequired || 'Consent is required to use the chat'}</div>
                    <button class="gdpr-btn gdpr-btn-reconsider" id="gdprReconsiderBtn">${texts.acceptButton || 'Accept & Continue'}</button>
                </div>
            </div>
        `;
    }

    // ═══════════════════════════════════════════════════════════
    // ОБРАБОТЧИКИ СОБЫТИЙ
    // ═══════════════════════════════════════════════════════════

    setupEventListeners() {
        // Кнопка Accept
        const acceptBtn = document.getElementById('gdprAcceptBtn');
        if (acceptBtn) {
            acceptBtn.addEventListener('click', () => this.handleAccept());
        }

        // Кнопка Decline
        const declineBtn = document.getElementById('gdprDeclineBtn');
        if (declineBtn) {
            declineBtn.addEventListener('click', () => this.handleDecline());
        }

        // Кнопка Reconsider
        const reconsiderBtn = document.getElementById('gdprReconsiderBtn');
        if (reconsiderBtn) {
            reconsiderBtn.addEventListener('click', () => this.handleReconsider());
        }

        // Pre-chat форма
        const preChatForm = document.getElementById('gdprPreChatFormElement');
        if (preChatForm) {
            preChatForm.addEventListener('submit', (e) => this.handlePreChatSubmit(e));
        }
    }

    handleAccept() {
        this.saveConsent(true);
        this.hideConsentBanner();

        // Отправляем вебхук о согласии
        this.sendConsentWebhook(true);

        // Показываем pre-chat форму если нужно
        if (this.isPreChatRequired()) {
            this.showPreChatForm();
        } else {
            this.chat.onGDPRComplete();
        }
    }

    handleDecline() {
        this.saveConsent(false);
        this.hideConsentBanner();
        this.showDeclinedMessage();

        // Отправляем вебхук об отказе
        this.sendConsentWebhook(false);
    }

    handleReconsider() {
        this.consentDeclined = false;
        localStorage.removeItem(this.consentKey);
        this.hideDeclinedMessage();
        this.showConsentBanner();
    }

    handlePreChatSubmit(e) {
        e.preventDefault();

        const form = e.target;
        const formData = {};

        // Собираем данные формы
        const fields = this.config.preChatForm?.fields || [];
        fields.forEach(field => {
            const input = form.querySelector(`[name="${field.id}"]`);
            if (input) {
                formData[field.id] = input.value;
            }
        });

        // Проверяем GDPR чекбокс
        const gdprCheckbox = document.getElementById('gdprFormCheckbox');
        if (gdprCheckbox && !gdprCheckbox.checked) {
            const texts = this.getTexts();
            this.showNotification(texts.formValidationError || 'Please fill in all required fields', 'error');
            return;
        }

        // Сохраняем данные
        this.savePreChatData(formData);

        // Отправляем вебхук с данными формы
        this.sendPreChatWebhook(formData);

        this.hidePreChatForm();
        this.chat.onGDPRComplete();
    }

    // ═══════════════════════════════════════════════════════════
    // UI HELPERS
    // ═══════════════════════════════════════════════════════════

    hideConsentBanner() {
        const banner = document.getElementById('gdprConsentBanner');
        if (banner) {
            banner.classList.add('gdpr-hiding');
            setTimeout(() => banner.remove(), 300);
        }
    }

    showConsentBanner() {
        const container = this.chat.widget;
        if (container) {
            const existingBanner = document.getElementById('gdprConsentBanner');
            if (existingBanner) existingBanner.remove();

            // Вставляем баннер после header
            const header = container.querySelector('.webchat-header');
            if (header) {
                header.insertAdjacentHTML('afterend', this.renderConsentBanner());
            } else {
                container.insertAdjacentHTML('afterbegin', this.renderConsentBanner());
            }
            this.setupEventListeners();
        }
    }

    hidePreChatForm() {
        const form = document.getElementById('gdprPreChatForm');
        if (form) {
            form.classList.add('gdpr-hiding');
            setTimeout(() => form.remove(), 300);
        }
    }

    showPreChatForm() {
        const container = this.chat.widget;
        if (container) {
            const header = container.querySelector('.webchat-header');
            if (header) {
                header.insertAdjacentHTML('afterend', this.renderPreChatForm());
            } else {
                container.insertAdjacentHTML('afterbegin', this.renderPreChatForm());
            }
            this.setupEventListeners();
        }
    }

    hideDeclinedMessage() {
        const msg = document.getElementById('gdprDeclinedMessage');
        if (msg) {
            msg.classList.add('gdpr-hiding');
            setTimeout(() => msg.remove(), 300);
        }
    }

    showDeclinedMessage() {
        const container = this.chat.widget;
        if (container) {
            const header = container.querySelector('.webchat-header');
            if (header) {
                header.insertAdjacentHTML('afterend', this.renderDeclinedMessage());
            } else {
                container.insertAdjacentHTML('afterbegin', this.renderDeclinedMessage());
            }
            this.setupEventListeners();
        }
    }

    showNotification(message, type = 'info') {
        // Создаем toast уведомление
        const toast = document.createElement('div');
        toast.className = `gdpr-toast gdpr-toast-${type}`;
        toast.textContent = message;

        document.body.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('gdpr-toast-show');
        }, 10);

        setTimeout(() => {
            toast.classList.remove('gdpr-toast-show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ═══════════════════════════════════════════════════════════
    // ПРОВЕРКА ГОТОВНОСТИ К ЧАТУ
    // ═══════════════════════════════════════════════════════════

    shouldBlockChat() {
        if (!this.isEnabled()) return false;
        if (!this.config.consentBanner?.blockChat) return false;

        return !this.hasConsent();
    }

    isReadyForChat() {
        if (!this.isEnabled()) return true;

        // Проверяем согласие
        if (this.config.consentBanner?.enabled && !this.hasConsent()) {
            return false;
        }

        // Проверяем pre-chat форму
        if (this.config.preChatForm?.enabled && !this.preChatCompleted) {
            return false;
        }

        return true;
    }

    // ═══════════════════════════════════════════════════════════
    // PRIVACY CONTROLS MENU
    // ═══════════════════════════════════════════════════════════

    renderPrivacyControls() {
        if (!this.isEnabled() || !this.config.privacyControls?.enabled) return '';

        const texts = this.getTexts();
        const options = this.config.privacyControls?.options || {};

        return `
            <div class="gdpr-privacy-controls" id="gdprPrivacyControls">
                <button class="gdpr-privacy-trigger" id="gdprPrivacyTrigger" title="${texts.privacyMenuTitle || 'Privacy Settings'}">
                    🔒
                </button>
                <div class="gdpr-privacy-menu" id="gdprPrivacyMenu">
                    <div class="gdpr-privacy-menu-header">
                        ${texts.privacyMenuTitle || 'Privacy Settings'}
                    </div>
                    <div class="gdpr-privacy-menu-divider"></div>
                    ${options.viewData ? `
                        <button class="gdpr-privacy-menu-item" id="gdprViewData">
                            <span>📋</span>
                            <span>${texts.viewDataButton || 'View My Data'}</span>
                        </button>
                    ` : ''}
                    ${options.exportData ? `
                        <button class="gdpr-privacy-menu-item" id="gdprExportData">
                            <span>📥</span>
                            <span>${texts.exportDataButton || 'Export Data'}</span>
                        </button>
                    ` : ''}
                    ${options.deleteHistory ? `
                        <button class="gdpr-privacy-menu-item" id="gdprDeleteHistory">
                            <span>🗑️</span>
                            <span>${texts.deleteHistoryButton || 'Delete Chat History'}</span>
                        </button>
                    ` : ''}
                    ${options.revokeConsent ? `
                        <div class="gdpr-privacy-menu-divider"></div>
                        <button class="gdpr-privacy-menu-item gdpr-danger" id="gdprRevokeConsent">
                            <span>⚠️</span>
                            <span>${texts.revokeConsentButton || 'Revoke Consent'}</span>
                        </button>
                    ` : ''}
                    ${options.deleteAllData ? `
                        <button class="gdpr-privacy-menu-item gdpr-danger" id="gdprDeleteAllData">
                            <span>🗑️</span>
                            <span>${texts.deleteAllDataButton || 'Delete All My Data'}</span>
                        </button>
                    ` : ''}
                </div>
            </div>
        `;
    }

    setupPrivacyControlsListeners() {
        const trigger = document.getElementById('gdprPrivacyTrigger');
        const menu = document.getElementById('gdprPrivacyMenu');

        if (trigger && menu) {
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                menu.classList.toggle('gdpr-menu-open');
            });

            // Закрытие меню при клике вне его
            document.addEventListener('click', (e) => {
                if (!menu.contains(e.target) && !trigger.contains(e.target)) {
                    menu.classList.remove('gdpr-menu-open');
                }
            });
        }

        // View Data
        const viewDataBtn = document.getElementById('gdprViewData');
        if (viewDataBtn) {
            viewDataBtn.addEventListener('click', () => this.handleViewData());
        }

        // Export Data
        const exportDataBtn = document.getElementById('gdprExportData');
        if (exportDataBtn) {
            exportDataBtn.addEventListener('click', () => this.handleExportData());
        }

        // Delete History
        const deleteHistoryBtn = document.getElementById('gdprDeleteHistory');
        if (deleteHistoryBtn) {
            deleteHistoryBtn.addEventListener('click', () => this.handleDeleteHistory());
        }

        // Revoke Consent
        const revokeConsentBtn = document.getElementById('gdprRevokeConsent');
        if (revokeConsentBtn) {
            revokeConsentBtn.addEventListener('click', () => this.handleRevokeConsent());
        }

        // Delete All Data
        const deleteAllDataBtn = document.getElementById('gdprDeleteAllData');
        if (deleteAllDataBtn) {
            deleteAllDataBtn.addEventListener('click', () => this.handleDeleteAllData());
        }
    }

    // ═══════════════════════════════════════════════════════════
    // WEBHOOKS
    // ═══════════════════════════════════════════════════════════

    async sendWebhook(url, data) {
        if (!url) return null;

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    timestamp: new Date().toISOString(),
                    sessionId: this.chat.sessionId,
                    userId: this.getUserId(),
                    ...data
                })
            });

            if (!response.ok) {
                console.warn('GDPR Webhook error:', response.status);
                return null;
            }

            return await response.json();
        } catch (e) {
            console.warn('GDPR Webhook failed:', e);
            return null;
        }
    }

    getUserId() {
        // Генерируем или получаем уникальный ID пользователя
        let userId = localStorage.getItem(this.storagePrefix + 'user_id');
        if (!userId) {
            userId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            localStorage.setItem(this.storagePrefix + 'user_id', userId);
        }
        return userId;
    }

    async sendConsentWebhook(accepted) {
        const webhookUrl = this.config.webhooks?.consent;
        if (!webhookUrl) return;

        await this.sendWebhook(webhookUrl, {
            type: 'consent',
            action: accepted ? 'accepted' : 'declined',
            privacyPolicyVersion: this.config.privacyPolicyVersion || '1.0',
            userData: this.userData
        });
    }

    async sendPreChatWebhook(formData) {
        const webhookUrl = this.config.webhooks?.preChatForm;
        if (!webhookUrl) return;

        await this.sendWebhook(webhookUrl, {
            type: 'prechat_form',
            formData: formData
        });
    }

    // ═══════════════════════════════════════════════════════════
    // DATA OPERATIONS HANDLERS
    // ═══════════════════════════════════════════════════════════

    async handleViewData() {
        const texts = this.getTexts();
        const webhookUrl = this.config.webhooks?.dataAccess;

        this.showNotification(texts.requestingData || 'Requesting your data...', 'info');

        if (webhookUrl) {
            const result = await this.sendWebhook(webhookUrl, {
                type: 'data_access',
                action: 'view'
            });

            if (result && result.data) {
                this.showDataModal(result.data);
            } else {
                // Показываем локальные данные
                this.showDataModal(this.getLocalData());
            }
        } else {
            this.showDataModal(this.getLocalData());
        }
    }

    async handleExportData() {
        const texts = this.getTexts();
        const webhookUrl = this.config.webhooks?.dataExport;

        this.showNotification(texts.exportingData || 'Preparing data export...', 'info');

        let dataToExport = this.getLocalData();

        if (webhookUrl) {
            const result = await this.sendWebhook(webhookUrl, {
                type: 'data_export',
                action: 'export'
            });

            if (result && result.data) {
                dataToExport = { ...dataToExport, ...result.data };
            }
        }

        // Скачиваем как JSON
        this.downloadAsJSON(dataToExport, 'my_chat_data.json');
        this.showNotification(texts.dataExported || 'Data exported successfully', 'success');
    }

    async handleDeleteHistory() {
        const texts = this.getTexts();

        if (!confirm(texts.confirmDeleteHistory || 'Are you sure you want to delete your chat history?')) {
            return;
        }

        // Удаляем локальную историю
        this.chat.clearChatHistory();

        const webhookUrl = this.config.webhooks?.dataDelete;
        if (webhookUrl) {
            await this.sendWebhook(webhookUrl, {
                type: 'data_delete',
                action: 'delete_history'
            });
        }

        this.showNotification(texts.historyDeleted || 'Chat history deleted', 'success');
    }

    async handleRevokeConsent() {
        const texts = this.getTexts();

        if (!confirm(texts.confirmRevokeConsent || 'Are you sure you want to revoke your consent? This will end your chat session.')) {
            return;
        }

        this.revokeConsent();

        const webhookUrl = this.config.webhooks?.consent;
        if (webhookUrl) {
            await this.sendWebhook(webhookUrl, {
                type: 'consent',
                action: 'revoked'
            });
        }

        this.showNotification(texts.consentRevoked || 'Consent revoked', 'info');

        // Показываем consent banner снова
        setTimeout(() => {
            window.location.reload();
        }, 1500);
    }

    async handleDeleteAllData() {
        const texts = this.getTexts();

        if (!confirm(texts.confirmDeleteAllData || 'Are you sure you want to delete ALL your data? This action cannot be undone.')) {
            return;
        }

        // Удаляем все локальные данные
        this.deleteAllLocalData();

        const webhookUrl = this.config.webhooks?.dataDelete;
        if (webhookUrl) {
            await this.sendWebhook(webhookUrl, {
                type: 'data_delete',
                action: 'delete_all'
            });
        }

        this.showNotification(texts.allDataDeleted || 'All data deleted', 'success');

        setTimeout(() => {
            window.location.reload();
        }, 1500);
    }

    // ═══════════════════════════════════════════════════════════
    // DATA HELPERS
    // ═══════════════════════════════════════════════════════════

    getLocalData() {
        return {
            consent: {
                given: this.consentGiven,
                timestamp: localStorage.getItem(this.consentKey) ?
                    JSON.parse(localStorage.getItem(this.consentKey))?.timestamp : null
            },
            userData: this.userData,
            sessionId: this.chat.sessionId,
            chatHistory: this.chat.exportChatHistory ? this.chat.exportChatHistory() : []
        };
    }

    deleteAllLocalData() {
        // Удаляем все GDPR-связанные данные
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(this.storagePrefix)) {
                keysToRemove.push(key);
            }
        }
        keysToRemove.forEach(key => localStorage.removeItem(key));

        // Очищаем историю чата
        if (this.chat.clearChatHistory) {
            this.chat.clearChatHistory();
        }
    }

    downloadAsJSON(data, filename) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    showDataModal(data) {
        const texts = this.getTexts();

        // Создаем модальное окно
        const modal = document.createElement('div');
        modal.className = 'gdpr-data-modal';
        modal.innerHTML = `
            <div class="gdpr-data-modal-content">
                <div class="gdpr-data-modal-header">
                    <span>${texts.yourDataTitle || 'Your Data'}</span>
                    <button class="gdpr-data-modal-close">&times;</button>
                </div>
                <div class="gdpr-data-modal-body">
                    <pre>${JSON.stringify(data, null, 2)}</pre>
                </div>
                <div class="gdpr-data-modal-footer">
                    <button class="gdpr-btn gdpr-btn-accept" id="gdprExportFromModal">
                        ${texts.exportDataButton || 'Export Data'}
                    </button>
                    <button class="gdpr-btn gdpr-btn-decline gdpr-close-modal">
                        ${texts.closeButton || 'Close'}
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Обработчики
        modal.querySelector('.gdpr-data-modal-close').addEventListener('click', () => modal.remove());
        modal.querySelector('.gdpr-close-modal').addEventListener('click', () => modal.remove());
        modal.querySelector('#gdprExportFromModal').addEventListener('click', () => {
            this.downloadAsJSON(data, 'my_chat_data.json');
        });

        // Закрытие по клику на фон
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
    }

    // ═══════════════════════════════════════════════════════════
    // AI DISCLOSURE & SECURITY INDICATORS
    // ═══════════════════════════════════════════════════════════

    renderAIDisclosure() {
        if (!this.isEnabled() || !this.config.aiDisclosure?.enabled) return '';
        if (!this.config.aiDisclosure?.showBadge) return '';

        const texts = this.getTexts();
        return `
            <div class="gdpr-ai-badge" title="${texts.aiDisclosureTooltip || 'This chat uses AI technology'}">
                <span class="gdpr-ai-badge-icon">🤖</span>
                <span>${texts.aiDisclosureBadge || 'AI Assistant'}</span>
            </div>
        `;
    }

    renderSecurityIndicator() {
        if (!this.isEnabled() || !this.config.securityIndicators?.showSecureBadge) return '';

        const texts = this.getTexts();
        const isSecure = window.location.protocol === 'https:';

        if (!isSecure && this.config.advanced?.httpsOnly) return '';

        return `
            <div class="gdpr-security-indicator" title="${texts.securityTooltip || 'Secure connection'}">
                <span class="gdpr-security-icon">${isSecure ? '🔒' : '⚠️'}</span>
                <span>${isSecure ? (texts.secureConnection || 'Secure') : (texts.insecureConnection || 'Not Secure')}</span>
            </div>
        `;
    }

    // ═══════════════════════════════════════════════════════════
    // REVOKE CONSENT
    // ═══════════════════════════════════════════════════════════

    revokeConsent() {
        localStorage.removeItem(this.consentKey);
        localStorage.removeItem(this.preChatDataKey);
        this.consentGiven = false;
        this.consentDeclined = false;
        this.preChatCompleted = false;
        this.userData = {};
    }
}

// ===============================================
// SIMPLE WEB CHAT CLASS
// ===============================================
class SimpleWebChat {
    constructor(config = {}) {
    
    // Настройка включенных конфигураций
if (window.webchatEnabledConfigs && Array.isArray(window.webchatEnabledConfigs)) {
    setTimeout(() => {
        if (window.ChatConfigManager) {
            // ✅ Получаем только включенные конфигурации из webchat-config.js
            let allConfigs = [];
            
            if (typeof window.getAvailableConfigs === 'function') {
                allConfigs = Object.keys(window.getAvailableConfigs());
                console.log('🔧 Получено включенных конфигураций:', allConfigs.length, allConfigs);
            } else {
                console.warn('⚠️ Функция getAvailableConfigs() не найдена');
            }
            
            // Отключаем все включенные конфигурации
            allConfigs.forEach(config => {
                window.ChatConfigManager.setConfigEnabled(config, false);
            });
            
            // Включаем только указанные в webchatEnabledConfigs
            window.webchatEnabledConfigs.forEach((config, index) => {
                window.ChatConfigManager.setConfigEnabled(config, true);
                window.ChatConfigManager.setConfigOrder(config, index + 1);
            });
            
            console.log('✅ Включены конфигурации:', window.webchatEnabledConfigs);
        }
    }, 100);
}
        
        // Инициализация конфигурации
        this.config = Object.assign({}, window.WebChatConfig || {}, config);
        
        // ✅ ИСПРАВЛЕНИЕ: Определяем язык СРАЗУ
        this.currentLanguage = this.config.language || 'ru';
        
        // Получение текстов с fallback
        if (typeof this.config.getTexts === 'function') {
            this.texts = this.config.getTexts();
        } else {
            // ✅ ИСПРАВЛЕНИЕ: Используем правильный метод для fallback текстов
            this.texts = this.getFallbackTexts();
            
            // Если есть тексты в конфигурации, используем их
            if (this.config.texts && this.config.texts[this.currentLanguage]) {
                const configTexts = this.config.texts[this.currentLanguage];
                Object.assign(this.texts, {
                    headerTitle: configTexts.headerTitle || this.texts.headerTitle,
                    headerSubtitle: configTexts.headerSubtitle || this.texts.headerSubtitle,
                    welcomeMessage: configTexts.welcomeMessage || this.texts.welcomeMessage,
                    quickButtons: configTexts.quickButtons || this.texts.quickButtons
                });
                
                if (configTexts.interface) {
                    Object.assign(this.texts.interface, configTexts.interface);
                }
                if (configTexts.errors) {
                    Object.assign(this.texts.errors, configTexts.errors);
                }
                if (configTexts.system) {
                    Object.assign(this.texts.system, configTexts.system);
                }
            }
        }
        
        // Состояние чата
        this.sessionId = this.generateSessionId();
        this.isRecording = false;
        this.mediaRecorder = null;
        this.chatHistory = [];
        this.isMinimized = true;
        this.isCompactMode = this.shouldUseCompactMode();
        this.isConnected = false;
        this.currentConfigName = this.getCurrentConfigName();
        // ✅ НОВОЕ: Настройки темы
        this.currentTheme = this.determineTheme();
        
        // ✅ НОВОЕ: Настройки переключателя
        this.showConfigSwitcher = this.shouldShowSwitcher();
        this.availableConfigs = this.getAvailableConfigs();
        // ✅ ИСПРАВЛЕННОЕ: Инициализация языковых настроек
        this.supportedLanguages = [];
        this.showLanguageSwitcher = false;
        // ✅ НОВОЕ: Настройки файлов
        this.fileSettings = {
            maxFileSize: this.config.technical?.maxFileSize || 10 * 1024 * 1024, // 10MB
            allowedTypes: this.config.technical?.allowedFileTypes || [
                'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
                'application/pdf', 'text/plain', 'text/csv',
                'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            ],
            enablePasteImages: this.config.behavior?.enablePasteImages !== false, // по умолчанию включено
            enableFileUpload: this.config.behavior?.enableFileUpload !== false    // по умолчанию включено
        };
        
        // ✅ НОВОЕ: Состояние файлов
        this.currentFile = null;
        this.filePreviewElement = null;
        this.currentPreviewImageUrl = null; // ✅ Для освобождения памяти URL.createObjectURL
        // ✅ НОВОЕ: Мониторинг и аналитика
this.monitoring = {
    sessionStartTime: new Date().toISOString(),
    messageCount: 0,
    lastActivityTime: new Date().toISOString(),
    userAgent: navigator.userAgent,
    screenResolution: `${window.screen.width}x${window.screen.height}`,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    referrer: document.referrer,
    currentUrl: window.location.href
};
this.monitoringEnabled = this.config.monitoring?.enabled || false;
this.monitoringEndpoint = this.config.monitoring?.endpoint || null;
this.monitoringInterval = null;

        // ✅ НОВОЕ: Rate Limiting для защиты от спама
        this.rateLimiting = {
            enabled: this.config.security?.rateLimiting?.enabled !== false, // по умолчанию включено
            maxMessagesPerMinute: this.config.security?.rateLimiting?.maxMessagesPerMinute || 10,
            maxMessagesPerHour: this.config.security?.rateLimiting?.maxMessagesPerHour || 60,
            messageTimestamps: [],
            isBlocked: false,
            blockedUntil: null
        };
        
        // Инициализируем языковые настройки после полной загрузки конфига
        setTimeout(() => {
            this.initializeLanguageSettings();
        }, 100);
        // ✅ НОВОЕ: Инициализация состояния быстрых кнопок
        this.quickButtonsCollapsed = this.config.behavior && this.config.behavior.quickButtonsCollapsed === true;
        
        // Элементы DOM
        this.widget = null;
        this.messagesContainer = null;
        this.messageInput = null;
        this.statusIndicator = null;
        this.typingIndicator = null;
        this.configSelect = null;
        // ✅ НОВОЕ: Свойства для системы времени
        this.scrollDateTimeout = null;
        this.scrollDateElement = null;
        this.lastScrollDate = null;
        this.scrollHandler = null;
        
        this.log('info', '🤖 Simple Web Chat initialized');
        this.log('debug', '🔤 Language:', this.config.language);
        this.log('debug', '🆔 Session ID:', this.sessionId);
        this.log('debug', '🎛️ Config Switcher:', this.showConfigSwitcher ? 'ENABLED' : 'DISABLED');
        this.log('debug', '🖼️ Popout mode:', this.config.behavior?.enablePopoutMode ? 'ENABLED' : 'DISABLED');
        // ✅ ИСПРАВЛЕННОЕ: Инициализируем язык с учетом автоопределения
        this.currentLanguage = this.determineInitialLanguage();
        this.config.language = this.currentLanguage; // Синхронизируем конфиг

        // ✅ НОВОЕ: Сразу обновляем тексты если язык отличается от дефолтного
        if (this.currentLanguage !== this.config.defaultLanguage) {
            // Обновляем тексты под сохраненный язык
            if (this.config.getTexts) {
                this.texts = this.config.getTexts();
            } else if (this.config.texts && this.config.texts[this.currentLanguage]) {
                this.texts = this.config.texts[this.currentLanguage];
            }
        }

        this.log('info', `🌍 Инициализирован язык: ${this.currentLanguage}`);

        // ✅ НОВОЕ: GDPR Manager для управления согласием и приватностью
        this.gdprManager = null;
        this.gdprReady = false;

        this.init();
    }

    // ✅ НОВОЕ: Инициализация GDPR системы
    initGDPR() {
        if (!this.config.gdpr?.enabled) {
            this.gdprReady = true;
            this.log('info', '🔒 GDPR отключен в настройках');
            return;
        }

        this.gdprManager = new GDPRManager(this);

        // Проверяем нужно ли показывать GDPR элементы
        if (this.gdprManager.shouldBlockChat()) {
            // Показываем consent banner или declined message
            if (this.gdprManager.hasConsent() === false) {
                // Пользователь ранее отклонил - показываем declined message
                this.gdprManager.showDeclinedMessage();
            } else if (!this.gdprManager.hasConsent()) {
                // Еще не давал согласие - показываем banner
                this.gdprManager.showConsentBanner();
            } else if (this.gdprManager.isPreChatRequired()) {
                // Согласие есть, но нужна pre-chat форма
                this.gdprManager.showPreChatForm();
            }
        } else {
            this.gdprReady = true;
        }

        this.log('info', '🔒 GDPR Manager инициализирован');
    }

    // ✅ НОВОЕ: Callback когда GDPR процесс завершен
    onGDPRComplete() {
        this.gdprReady = true;
        this.log('info', '✅ GDPR согласие получено, чат готов к работе');

        // Показываем приветственное сообщение если настроено
        if (this.config.behavior?.showWelcome !== false) {
            const welcomeText = this.texts?.welcomeMessage || this.config.texts?.welcomeMessage;
            if (welcomeText && this.messagesContainer) {
                // Проверяем что сообщение еще не показано
                const existingWelcome = this.messagesContainer.querySelector('.webchat-message.bot');
                if (!existingWelcome) {
                    this.addMessage(welcomeText, 'bot');
                }
            }
        }

        // Автофокус на поле ввода
        if (this.messageInput && !this.isMinimized) {
            setTimeout(() => this.messageInput.focus(), 100);
        }
    }
    
    // ✅ ПРАВИЛЬНЫЙ МЕТОД: Минимальные fallback тексты (только резерв!)
    getFallbackTexts() {
        // 🎯 ГЛАВНОЕ: Сначала пытаемся использовать тексты из КОНФИГА
        if (this.config.getTexts && typeof this.config.getTexts === 'function') {
            try {
                return this.config.getTexts();
            } catch (error) {
                this.log('warn','⚠️ Ошибка получения текстов из конфига, используем fallback:', error);
            }
        }
        
        // Если конфиг недоступен - используем минимальные резервные тексты
        const isEnglish = this.currentLanguage === 'en';
        
        return {
            headerTitle: this.config.botInfo?.name || (isEnglish ? 'Chat' : 'Чат'),
            headerSubtitle: this.config.botInfo?.description || (this.texts.fallback?.assistant || 'Assistant'),
            welcomeMessage: this.texts.fallback?.welcome || 'Welcome!',
            quickButtons: [],
            interface: {
                minimize: isEnglish ? "Minimize" : "Свернуть",
                expand: isEnglish ? "Expand" : "Развернуть",
                placeholder: isEnglish ? "Type a message..." : "Введите сообщение...",
                voiceTooltip: isEnglish ? "Voice message" : "Голосовое сообщение",
                sendTooltip: isEnglish ? "Send message" : "Отправить сообщение",
                typingIndicator: isEnglish ? "Typing" : "Отвечаю",
                fileTooltip: isEnglish ? "Attach file" : "Прикрепить файл",
                fileUploading: isEnglish ? "Uploading file..." : "Отправляем файл...",
                fileTooLarge: isEnglish ? "File too large" : "Файл слишком большой",
                fileTypeNotAllowed: isEnglish ? "File type not supported" : "Тип файла не поддерживается",
                fileError: isEnglish ? "File processing error" : "Ошибка при обработке файла"
            },
            errors: {
                connectionError: isEnglish ? "❌ Connection error" : "❌ Ошибка подключения",
                fallbackMessage: isEnglish ? "Technical issue. Try later." : "Техническая проблема. Попробуйте позже.",
                microphoneAccess: isEnglish ? "❌ No microphone access" : "❌ Нет доступа к микрофону",
                voiceProcessing: isEnglish ? "❌ Voice processing error" : "❌ Ошибка обработки голоса"
            },
            system: {
                connecting: isEnglish ? "Connecting..." : "Подключаюсь...",
                voiceMessage: isEnglish ? "🎤 Voice message" : "🎤 Голосовое сообщение",
                switching: isEnglish ? "Switching to" : "Переключаюсь на",
                nowServing: isEnglish ? "Now serving you" : "Теперь вас обслуживает"
            }
        };
        
        this.init();
    }
    
// ✅ НОВЫЕ МЕТОДЫ ДЛЯ КОМПАКТНОГО РЕЖИМА
    shouldUseCompactMode() {
        // Всегда используем компактный режим
        return true;
    }

    // ✅ УСТАРЕЛО: Функция больше не используется (виджеты управляются через createFloatingWidget)
    getCompactSize() {
        return { width: 70, height: 70 }; // Возвращаем фиктивные данные для обратной совместимости
    }

getCompactPosition() {
    const appearance = this.config.appearance || {};
    return appearance.compactMinimizedPosition || null;
}

    // ✅ УСТАРЕЛО: Функция больше не используется (виджеты управляются через createFloatingWidget)
    applyCompactSizing() {
        // Пустая функция для обратной совместимости
        return;
    }

    // Функция экранирования HTML для защиты от XSS
     escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
    }
    
    // ✅ УЛУЧШЕННЫЙ МЕТОД: Санитизация HTML с расширенной защитой от XSS
sanitizeHTML(html) {
    if (!html) return '';

    // Разрешенные теги и атрибуты
    const allowedTags = {
        'b': [],
        'i': [],
        'u': [],
        'strong': [],
        'em': [],
        'br': [],
        'p': [],
        'div': [],
        'span': [],
        'a': ['href', 'title', 'target', 'rel'],
        'ul': [],
        'ol': [],
        'li': [],
        'h1': [], 'h2': [], 'h3': [], 'h4': [], 'h5': [], 'h6': [],
        'blockquote': [],
        'code': [],
        'pre': [],
        'img': ['src', 'alt', 'title', 'width', 'height', 'class', 'style'],
        'video': ['src', 'controls', 'width', 'height', 'poster', 'class', 'style'],
        'audio': ['src', 'controls', 'class']
    };

    // ✅ КРИТИЧЕСКАЯ БЕЗОПАСНОСТЬ: Проверка опасных URL схем
    const isSafeURL = (url) => {
        if (!url) return false;

        const urlLower = url.toLowerCase().trim();

        // Блокируем опасные схемы
        const dangerousSchemes = [
            'javascript:', 'data:', 'vbscript:', 'file:', 'about:',
            'ws:', 'wss:'
        ];

        for (const scheme of dangerousSchemes) {
            if (urlLower.startsWith(scheme)) {
                return false;
            }
        }

        // Разрешаем безопасные схемы (blob: нужен для изображений/видео)
        return urlLower.startsWith('http://') ||
               urlLower.startsWith('https://') ||
               urlLower.startsWith('blob:') ||
               urlLower.startsWith('/') ||
               urlLower.startsWith('#');
    };

    // Создаем временный элемент
    const temp = document.createElement('div');
    temp.innerHTML = html;

    // Рекурсивная очистка
    const cleanNode = (node) => {
        // Если это текстовый узел - возвращаем как есть
        if (node.nodeType === Node.TEXT_NODE) {
            return node.cloneNode();
        }

        // Если это элемент
        if (node.nodeType === Node.ELEMENT_NODE) {
            const tagName = node.tagName.toLowerCase();

            // Проверяем разрешен ли тег
            if (allowedTags[tagName]) {
                const newNode = document.createElement(tagName);

                // Копируем только разрешенные атрибуты
                const allowedAttrs = allowedTags[tagName];
                for (let attr of node.attributes) {
                    if (allowedAttrs.includes(attr.name)) {
                        // ✅ КРИТИЧЕСКАЯ ПРОВЕРКА: Безопасность href и src
                        if (attr.name === 'href' || attr.name === 'src') {
                            if (isSafeURL(attr.value)) {
                                newNode.setAttribute(attr.name, attr.value);
                                // ✅ Всегда добавляем безопасность для внешних ссылок (только для href)
                                if (attr.name === 'href' && (attr.value.startsWith('http://') || attr.value.startsWith('https://'))) {
                                    newNode.setAttribute('rel', 'noopener noreferrer');
                                    newNode.setAttribute('target', '_blank');
                                }
                            }
                        } else if (attr.name === 'target' && attr.value === '_blank') {
                            newNode.setAttribute(attr.name, attr.value);
                            newNode.setAttribute('rel', 'noopener noreferrer');
                        } else if (attr.name !== 'target') {
                            // ✅ Фильтруем потенциально опасные атрибуты
                            const attrValueLower = attr.value.toLowerCase();
                            if (!attrValueLower.includes('javascript:') &&
                                !attrValueLower.includes('data:') &&
                                !attrValueLower.includes('vbscript:')) {
                                newNode.setAttribute(attr.name, attr.value);
                            }
                        }
                    }
                }

                // Рекурсивно обрабатываем дочерние узлы
                for (let child of node.childNodes) {
                    const cleanedChild = cleanNode(child);
                    if (cleanedChild) {
                        newNode.appendChild(cleanedChild);
                    }
                }

                return newNode;
            }
            // Если тег не разрешен - возвращаем только его текстовое содержимое
            else {
                const textNode = document.createTextNode(node.textContent);
                return textNode;
            }
        }

        return null;
    };

    // Очищаем все дочерние узлы
    const cleaned = document.createElement('div');
    for (let child of temp.childNodes) {
        const cleanedChild = cleanNode(child);
        if (cleanedChild) {
            cleaned.appendChild(cleanedChild);
        }
    }

    return cleaned.innerHTML;
}

    // ✅ НОВАЯ ФУНКЦИЯ: Преобразование URL в кликабельные ссылки
linkifyText(text) {
    if (!text) return '';

    // Регулярное выражение для поиска URL (http, https)
    const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;

    // Заменяем URL на ссылки
    return text.replace(urlRegex, (url) => {
        // Убираем trailing знаки пунктуации, которые могут быть частью предложения
        let cleanUrl = url;
        let trailingPunctuation = '';

        // Проверяем и удаляем trailing пунктуацию
        const punctuationRegex = /([.,!?;:)\]]+)$/;
        const match = cleanUrl.match(punctuationRegex);
        if (match) {
            trailingPunctuation = match[1];
            cleanUrl = cleanUrl.slice(0, -trailingPunctuation.length);
        }

        // Создаем ссылку с безопасными атрибутами и инлайн-стилями для наследования цвета
        return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" style="color: inherit !important; text-decoration: none !important; cursor: pointer !important;">${cleanUrl}</a>${trailingPunctuation}`;
    });
}

    // ✅ ФУНКЦИЯ: Валидация текстового ввода (базовая проверка)
validateTextInput(text, maxLength = 1000) {
    if (typeof text !== 'string') {
        return { valid: false, error: 'Invalid input type' };
    }

    // Проверка на пустое значение
    const trimmed = text.trim();
    if (!trimmed) {
        return { valid: false, error: 'Empty input' };
    }

    // Проверка длины
    if (trimmed.length > maxLength) {
        return { valid: false, error: `Text too long (max: ${maxLength})` };
    }

    // Примечание: Опасные паттерны обрабатываются функцией sanitizeHTML при отображении
    return { valid: true, text: trimmed };
}

    // ✅ НОВАЯ ФУНКЦИЯ: Валидация файлов
validateFile(file) {
    if (!file) {
        return { valid: false, error: 'No file provided' };
    }

    // Проверка размера файла
    if (file.size > this.fileSettings.maxFileSize) {
        const maxSizeMB = Math.round(this.fileSettings.maxFileSize / (1024 * 1024));
        return { valid: false, error: `File too large (max: ${maxSizeMB}MB)` };
    }

    // Проверка типа файла (основная защита - браузер уже проверил MIME type)
    if (!this.fileSettings.allowedTypes.includes(file.type)) {
        return { valid: false, error: 'File type not allowed' };
    }

    // ✅ ПРОВЕРКА: Базовая проверка расширения файла
    const fileName = file.name.toLowerCase();
    const allowedExtensions = [
        '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
        '.pdf', '.txt', '.csv',
        '.doc', '.docx', '.xls', '.xlsx'
    ];

    const hasAllowedExtension = allowedExtensions.some(ext => fileName.endsWith(ext));
    if (!hasAllowedExtension) {
        return { valid: false, error: 'File extension not allowed' };
    }

    return { valid: true };
}

    // ✅ НОВАЯ ФУНКЦИЯ: Санитизация JSON данных
sanitizeJSON(data) {
    if (!data || typeof data !== 'object') {
        return data;
    }

    const sanitized = Array.isArray(data) ? [] : {};

    for (const key in data) {
        if (data.hasOwnProperty(key)) {
            const value = data[key];

            if (typeof value === 'string') {
                // Санитизируем строки
                sanitized[key] = this.escapeHtml(value);
            } else if (typeof value === 'object' && value !== null) {
                // Рекурсивно обрабатываем объекты
                sanitized[key] = this.sanitizeJSON(value);
            } else {
                // Примитивные типы копируем как есть
                sanitized[key] = value;
            }
        }
    }

    return sanitized;
}

    // ✅ НОВАЯ ФУНКЦИЯ: Проверка rate limiting
checkRateLimit() {
    if (!this.rateLimiting.enabled) {
        return { allowed: true };
    }

    const now = Date.now();

    // Проверяем, не заблокирован ли пользователь
    if (this.rateLimiting.isBlocked && this.rateLimiting.blockedUntil) {
        if (now < this.rateLimiting.blockedUntil) {
            const remainingSeconds = Math.ceil((this.rateLimiting.blockedUntil - now) / 1000);
            return {
                allowed: false,
                reason: 'blocked',
                message: `⏳ Вы временно заблокированы. Подождите ${remainingSeconds} секунд.`
            };
        } else {
            // Разблокируем пользователя
            this.rateLimiting.isBlocked = false;
            this.rateLimiting.blockedUntil = null;
            this.rateLimiting.messageTimestamps = [];
        }
    }

    // Удаляем старые временные метки (старше 1 часа)
    const oneHourAgo = now - 60 * 60 * 1000;
    this.rateLimiting.messageTimestamps = this.rateLimiting.messageTimestamps.filter(
        timestamp => timestamp > oneHourAgo
    );

    // Проверяем лимит за час
    if (this.rateLimiting.messageTimestamps.length >= this.rateLimiting.maxMessagesPerHour) {
        // Блокируем на 5 минут
        this.rateLimiting.isBlocked = true;
        this.rateLimiting.blockedUntil = now + 5 * 60 * 1000;
        this.log('warn', '⚠️ Rate limit превышен (час)', {
            count: this.rateLimiting.messageTimestamps.length,
            limit: this.rateLimiting.maxMessagesPerHour
        });

        return {
            allowed: false,
            reason: 'hour_limit',
            message: `⏳ Превышен лимит сообщений за час (${this.rateLimiting.maxMessagesPerHour}). Вы заблокированы на 5 минут.`
        };
    }

    // Проверяем лимит за минуту
    const oneMinuteAgo = now - 60 * 1000;
    const messagesLastMinute = this.rateLimiting.messageTimestamps.filter(
        timestamp => timestamp > oneMinuteAgo
    ).length;

    if (messagesLastMinute >= this.rateLimiting.maxMessagesPerMinute) {
        this.log('warn', '⚠️ Rate limit превышен (минута)', {
            count: messagesLastMinute,
            limit: this.rateLimiting.maxMessagesPerMinute
        });

        return {
            allowed: false,
            reason: 'minute_limit',
            message: (this.texts.rateLimiting?.tooManyMessages || '⏳ Too many messages. Maximum {max} messages per minute.')
                .replace('{max}', this.rateLimiting.maxMessagesPerMinute)
        };
    }

    return { allowed: true };
}

    // ✅ НОВАЯ ФУНКЦИЯ: Запись временной метки сообщения
recordMessageTimestamp() {
    if (this.rateLimiting.enabled) {
        this.rateLimiting.messageTimestamps.push(Date.now());
    }
}

    // ✅ ОПТИМИЗАЦИЯ: Debounce функция для оптимизации событий
debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

    // ✅ ОПТИМИЗАЦИЯ: Throttle функция для ограничения частоты вызовов
throttle(func, limit) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

    // ✅ КРИТИЧЕСКАЯ ОПТИМИЗАЦИЯ: Очистка старых сообщений из DOM
cleanupOldMessages() {
    if (!this.messagesContainer) return;

    const maxMessages = this.config.behavior?.maxHistoryMessages || 50;
    const messages = this.messagesContainer.querySelectorAll('.webchat-message');

    // Если сообщений больше чем лимит, удаляем старые
    if (messages.length > maxMessages) {
        const messagesToRemove = messages.length - maxMessages;
        for (let i = 0; i < messagesToRemove; i++) {
            // ✅ Очищаем audio/video элементы перед удалением
            const audioElements = messages[i].querySelectorAll('audio');
            audioElements.forEach(audio => {
                if (audio.src && audio.src.startsWith('blob:')) {
                    URL.revokeObjectURL(audio.src);
                }
                audio.pause();
                audio.src = '';
                audio.load();
            });

            const videoElements = messages[i].querySelectorAll('video');
            videoElements.forEach(video => {
                if (video.src && video.src.startsWith('blob:')) {
                    URL.revokeObjectURL(video.src);
                }
                video.pause();
                video.src = '';
                video.load();
            });

            // Удаляем сообщение из DOM
            messages[i].remove();
        }

        this.log('debug', `🧹 Очищено ${messagesToRemove} старых сообщений из DOM`);
    }
}

  // Централизованная система логирования
log(level, message, data = '') {
    // Получаем настройку debug из конфигурации
    const isDebug = this.config.technical && this.config.technical.debug === true;
    
    // Если debug выключен, показываем только критические ошибки
    if (!isDebug) {
        // Выходим из функции для всех логов кроме критических ошибок
        if (level !== 'error') {
            return;
        }
    }
    
    // Если debug включен или это ошибка - показываем лог
    if (console[level]) {
        const timestamp = new Date().toLocaleTimeString();
        console[level](`[WebChat ${timestamp}] ${message}`, data);
    }
}

// ✅ НОВОЕ: Определение эффективной темы
    determineTheme() {
        // Используем глобальную функцию если доступна
        if (typeof window.getEffectiveTheme === 'function') {
            return window.getEffectiveTheme(this.config);
        }
        
        // Fallback логика
        const configTheme = this.config.theme ? this.config.theme.mode : null;
        return configTheme || 'auto';
    }

    // ✅ НОВОЕ: Применение темы к виджету
    applyTheme(theme = null) {
        if (!this.widget) return;
        
        const targetTheme = theme || this.currentTheme || 'auto';
        
        // Удаляем все классы тем
        this.widget.classList.remove('webchat-theme-auto', 'webchat-theme-light', 'webchat-theme-dark');
        
        // Добавляем класс нужной темы
        this.widget.classList.add(`webchat-theme-${targetTheme}`);
        
        // Обновляем текущую тему
        this.currentTheme = targetTheme;
        
        this.log('info', `🎨 Применена тема: ${targetTheme}`);
    }

    // ✅ НОВОЕ: Проверка должен ли отображаться переключатель
    shouldShowSwitcher() {
        // Используем глобальную функцию если доступна
        if (typeof window.shouldShowConfigSwitcher === 'function') {
            return window.shouldShowConfigSwitcher();
        }
        
        // Fallback логика
        return false; // По умолчанию отключен если нет глобальных настроек
    }

    // ✅ НОВОЕ: Получение доступных конфигураций ДИНАМИЧЕСКИ
getAvailableConfigs() {
    // Используем глобальную функцию если доступна
    if (typeof window.getAvailableConfigs === 'function') {
        return window.getAvailableConfigs();
    }
    
    // Fallback: динамически собираем все конфигурации из window
    const configs = {};
    
    // Ищем все объекты в window, которые похожи на конфигурации
    for (let key in window) {
        if (key.endsWith('Config') && 
            typeof window[key] === 'object' && 
            window[key] !== null &&
            window[key].configId &&  // ✅ Проверяем наличие configId
            window[key].botInfo && 
            window[key].getTexts) {
            configs[key] = window[key];
        }
    }
    
    this.log('debug', '🔍 Найдено конфигураций:', Object.keys(configs).length);
    return configs;
}

    // ✅ НОВОЕ: Получение отсортированного списка для UI
    getSortedConfigsForUI() {
    // Используем глобальную функцию если доступна
    if (typeof window.getSortedConfigsForUI === 'function') {
        return window.getSortedConfigsForUI(this.currentLanguage);
    }
    
    const configs = this.getAvailableConfigs();
    const currentLanguage = this.currentLanguage || this.config.language || 'ru';
    
    // Преобразуем в массив с информацией для UI
    const configsArray = Object.keys(configs).map(configName => {
        const config = configs[configName];
        const switcherSettings = config.switcherSettings || {};
        
        // Получаем локализованное название
        let label = configName;
        if (switcherSettings.labels) {
            if (typeof switcherSettings.labels === 'object') {
                // Если labels - это объект с переводами
                label = switcherSettings.labels[currentLanguage] || 
                       switcherSettings.labels.ru || 
                       switcherSettings.labels.en || 
                       configName;
            } else {
                // Если labels - это строка
                label = switcherSettings.labels;
            }
        }
        
        return {
            value: configName,
            label: label,
            order: config.getSwitcherOrder ? config.getSwitcherOrder() : 999,
            config: config
        };
    });
    
    // Сортируем по порядку
    return configsArray.sort((a, b) => a.order - b.order);
}
    // ✅ НОВЫЕ МЕТОДЫ ДЛЯ РАБОТЫ С ЯЗЫКАМИ

    // Проверка - нужно ли показывать переключатель языков
    // ✅ ИСПРАВЛЕННЫЙ МЕТОД: Проверка показа переключателя языков
    shouldShowLanguageSwitcher() {
        try {
            // Проверяем глобальные настройки
            if (!window.GlobalConfigSettings || 
                !window.GlobalConfigSettings.languageSettings || 
                !window.GlobalConfigSettings.languageSettings.showLanguageSwitcher) {
                return false;
            }
            
            // Получаем поддерживаемые языки
            const supportedLangs = this.getSupportedLanguages();
            
            // Показываем только если есть больше одного языка
            const shouldShow = supportedLangs.length > 1;
            
            this.log('debug', '🌍 Проверка показа переключателя языков:', {
                globalSettingsExist: !!window.GlobalConfigSettings,
                languageSettingsExist: !!(window.GlobalConfigSettings && window.GlobalConfigSettings.languageSettings),
                showLanguageSwitcher: window.GlobalConfigSettings && window.GlobalConfigSettings.languageSettings ? window.GlobalConfigSettings.languageSettings.showLanguageSwitcher : false,
                supportedLanguages: supportedLangs,
                shouldShow: shouldShow
            });
            
            return shouldShow;
            
        } catch (error) {
            this.log('error', '❌ Ошибка проверки переключателя языков:', error);
            return false;
        }
    }

    // Получение поддерживаемых языков для текущей конфигурации
    // ✅ ИСПРАВЛЕННЫЙ МЕТОД: Получение поддерживаемых языков
    getSupportedLanguages() {
        try {
            if (this.config && this.config.supportedLanguages && Array.isArray(this.config.supportedLanguages)) {
                return this.config.supportedLanguages;
            }
            
            // Проверяем наличие текстов для разных языков
            if (this.config && this.config.texts && typeof this.config.texts === 'object') {
                const availableLanguages = Object.keys(this.config.texts);
                if (availableLanguages.length > 0) {
                    return availableLanguages;
                }
            }
            
            // Fallback к текущему языку конфигурации
            return [this.config && this.config.language ? this.config.language : 'ru'];
            
        } catch (error) {
            this.log('error', '❌ Ошибка получения поддерживаемых языков:', error);
            return ['ru']; // Безопасный fallback
        }
    }

    // Определение начального языка
    determineInitialLanguage() {
        // 1. Проверяем сохраненный выбор пользователя
    const savedLang = localStorage.getItem('webchat_user_language');
    if (savedLang && this.getSupportedLanguages().includes(savedLang)) {
        this.log('info', '🌍 Восстановлен сохраненный язык:', savedLang);
        return savedLang;
    }
        
        // 2. Автоопределение языка браузера (если включено)
        if (window.GlobalConfigSettings && window.GlobalConfigSettings.languageSettings && 
            window.GlobalConfigSettings.languageSettings.autoDetectLanguage) {
            
            const browserLang = navigator.language.split('-')[0]; // 'ru-RU' -> 'ru'
            if (this.getSupportedLanguages().includes(browserLang)) {
                return browserLang;
            }
        }
        
        // 3. Язык по умолчанию из конфигурации
        if (this.config.defaultLanguage && this.getSupportedLanguages().includes(this.config.defaultLanguage)) {
            return this.config.defaultLanguage;
        }
        
        // 4. Fallback
        return this.getSupportedLanguages()[0] || 'ru';
    }
// ✅ НОВЫЙ МЕТОД: Безопасная инициализация языковых настроек
    initializeLanguageSettings() {
        try {
            this.supportedLanguages = this.getSupportedLanguages();
            this.showLanguageSwitcher = this.shouldShowLanguageSwitcher();
            this.currentLanguage = this.determineInitialLanguage();
            
            // Обновляем конфигурацию
if (this.config) {
    this.config.language = this.currentLanguage;
}

// ✅ НОВОЕ: Принудительно обновляем тексты под сохраненный язык
if (this.currentLanguage !== this.config.defaultLanguage) {
    this.updateTextsForLanguage(this.currentLanguage);
}
            
            // Перерисовываем интерфейс если нужно добавить кнопки языков
            if (this.showLanguageSwitcher && this.widget) {
            this.updateHeaderElements();  // ✅ ИСПОЛЬЗУЕМ ПОЛНУЮ ПЕРЕРИСОВКУ
          }
            
            this.log('info', '🌍 Языковые настройки инициализированы:', {
                current: this.currentLanguage,
                supported: this.supportedLanguages,
                switcherEnabled: this.showLanguageSwitcher
            });
            
        } catch (error) {
            this.log('error', '❌ Ошибка инициализации языковых настроек:', error);
            // Fallback к безопасным значениям
            this.supportedLanguages = [this.config.language || 'ru'];
            this.showLanguageSwitcher = false;
            this.currentLanguage = this.config.language || 'ru';
        }
        // ✅ НОВОЕ: Принудительная синхронизация кнопок при инициализации
            setTimeout(() => {
                this.updateLanguageButtons();
                this.log('debug', '🔄 Кнопки языков синхронизированы с текущим языком');
            }, 200);
            // ✅ НОВОЕ: Принудительно обновляем все тексты интерфейса
if (this.widget) {
    this.updateInterfaceTexts();
    
    // Обновляем список конфигураций
    if (this.configSelect) {
        this.updateConfigSelectOptions();
    }
}
    }

// ✅ НОВЫЙ МЕТОД: Обновление текстов для конкретного языка
    updateTextsForLanguage(language) {
        try {
            // Временно устанавливаем язык в конфигурации
            const originalLanguage = this.config.language;
            this.config.language = language;
            
            // Получаем тексты для нужного языка
            if (this.config.getTexts) {
                this.texts = this.config.getTexts();
            } else if (this.config.texts && this.config.texts[language]) {
                const configTexts = this.config.texts[language];
                // Объединяем с базовыми текстами если нужно
                if (typeof getBaseInterfaceTexts === 'function') {
                    const baseTexts = getBaseInterfaceTexts(language);
                    this.texts = {
                        ...configTexts,
                        interface: { ...baseTexts.interface, ...(configTexts.interface || {}) },
                        errors: { ...baseTexts.errors, ...(configTexts.errors || {}) },
                        system: { ...baseTexts.system, ...(configTexts.system || {}) }
                    };
                } else {
                    this.texts = configTexts;
                }
            }
            
            // Обновляем интерфейс с новыми текстами
            if (this.widget) {
                this.updateInterfaceTexts();
            }
            
            this.log('info', `🔄 Тексты обновлены для языка: ${language}`);
            
        } catch (error) {
            this.log('error', '❌ Ошибка обновления текстов:', error);
        }
    }
    // Переключение языка
   // ✅ ИСПРАВЛЕННЫЙ switchLanguage с принудительным сбросом дата-системы
switchLanguage(newLanguage) {
    if (!this.getSupportedLanguages().includes(newLanguage)) {
        this.log('warn', '⚠️ Язык не поддерживается:', newLanguage);
        return false;
    }
    
    if (this.currentLanguage === newLanguage) {
        return true; // Уже установлен
    }
    
    this.log('info', `🌍 Переключение языка: ${this.currentLanguage} → ${newLanguage}`);
    
    // Обновляем язык в конфигурации
    this.config.language = newLanguage;
    this.currentLanguage = newLanguage;
    
    // Обновляем тексты
    this.texts = this.config.getTexts ? this.config.getTexts() : this.config.texts[newLanguage] || this.config.texts.ru;
    
    // Сохраняем выбор пользователя
    if (window.GlobalConfigSettings && window.GlobalConfigSettings.languageSettings && 
        window.GlobalConfigSettings.languageSettings.rememberUserChoice) {
        localStorage.setItem('webchat_user_language', newLanguage);
    }
    
    // Обновляем интерфейс
    this.updateInterface();
    this.updateLanguageButtons();
    // Обновляем список конфигураций на новом языке
if (this.configSelect) {
    this.updateConfigSelectOptions();
}
    // Обновляем список конфигураций на новом языке
if (this.configSelect) {
    this.updateConfigSelectOptions();
}
    
    // Показываем уведомление о смене языка
    const langNames = { ru: 'Русский', en: 'English' };
    this.addMessage(
        `🌍 Language changed to ${langNames[newLanguage] || newLanguage}`, 
        'bot'
    );
    
    setTimeout(() => {
        this.clearLanguageSwitchingMessages();
    }, 1000);
    
    setTimeout(() => {
    this.reinitializeFileHandlers();
    
// ✅ СБРАСЫВАЕМ КЭШ первых строк
this.cachedWelcomeLines = null;
this.clearWelcomeMessages();
this.clearDuplicateDateHeaders();

if (this.config.behavior && this.config.behavior.showWelcome) {
    this.addMessage(this.texts.welcomeMessage, 'bot');
}
    
    // ✅ ПРИНУДИТЕЛЬНЫЙ ПОЛНЫЙ СБРОС ДАТА-СИСТЕМЫ
    this.forceResetDateSystem();
    
}, 1000);
    
    this.log('info', '✅ Язык успешно переключен на:', newLanguage);
    return true;
    // Обновляем все подсказки после смены языка
    setTimeout(() => {
        this.updateInterfaceTexts();
        
    }, 100);
    
    return true;
}

    // ✅ НОВЫЙ МЕТОД: Полное обновление языковой системы
    updateLanguageSystem() {
    try {
        // Обновляем настройки для новой конфигурации
        this.supportedLanguages = this.getSupportedLanguages();
        this.showLanguageSwitcher = this.shouldShowLanguageSwitcher();
        
        // Проверяем поддерживается ли текущий язык в новой конфигурации
        if (!this.supportedLanguages.includes(this.currentLanguage)) {
            // Переключаемся на язык по умолчанию новой конфигурации
            this.currentLanguage = this.config.defaultLanguage || this.supportedLanguages[0] || 'ru';
            this.config.language = this.currentLanguage;
            
            this.log('info', `🌍 Язык изменен на поддерживаемый: ${this.currentLanguage}`);
        }
        
        // ✅ ИСПОЛЬЗУЕМ ПОЛНУЮ ПЕРЕРИСОВКУ ВМЕСТО ОТДЕЛЬНОГО МЕТОДА
        this.updateHeaderElements();
        
    } catch (error) {
        this.log('error', '❌ Ошибка обновления языковой системы:', error);
    }
}

    // ✅ ОБНОВЛЕННЫЙ МЕТОД: Обновление состояния кнопок языков
    updateLanguageButtons() {
        const langButtons = this.widget.querySelectorAll('.webchat-language-btn');
        langButtons.forEach(btn => {
            const btnLang = btn.getAttribute('data-language');
            if (btnLang === this.currentLanguage) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }
    // ✅ НОВЫЙ МЕТОД: Переключение выпадающего меню языков
    toggleLanguageDropdown() {
        const dropdown = this.widget.querySelector('.webchat-language-dropdown');
        const menu = this.widget.querySelector('.webchat-language-dropdown-menu');
        
        if (!dropdown || !menu) return;
        
        const isOpen = menu.classList.contains('show');
        
        if (isOpen) {
            menu.classList.remove('show');
            dropdown.classList.remove('open');
            this.log('debug', '🔽 Выпадающее меню языков закрыто');
        } else {
            // Закрываем другие открытые меню
            this.hideAllPopups();
            
            menu.classList.add('show');
            dropdown.classList.add('open');
            this.log('debug', '🔼 Выпадающее меню языков открыто');
        }
    }
    
    // ✅ НОВЫЙ МЕТОД: Закрытие выпадающего меню языков
    hideLanguageDropdown() {
        const dropdown = this.widget.querySelector('.webchat-language-dropdown');
        const menu = this.widget.querySelector('.webchat-language-dropdown-menu');
        
        if (dropdown && menu) {
            menu.classList.remove('show');
            dropdown.classList.remove('open');
        }
    }

// ✅ НОВОЕ: Получение IP и геолокации
async getGeoLocation() {
    try {
        // Используем бесплатный сервис для получения IP и геолокации
        const response = await this.fetchWithRetry('https://ipapi.co/json/');
        const data = await response.json();
        
        return {
            ip: data.ip || 'unknown',
            country: data.country_name || 'unknown',
            countryCode: data.country_code || 'unknown',
            city: data.city || 'unknown',
            region: data.region || 'unknown',
            latitude: data.latitude || null,
            longitude: data.longitude || null,
            org: data.org || 'unknown'
        };
    } catch (error) {
        this.log('error', '❌ Ошибка получения геолокации:', error);
        return {
            ip: 'unknown',
            country: 'unknown',
            countryCode: 'unknown',
            city: 'unknown',
            region: 'unknown',
            latitude: null,
            longitude: null,
            org: 'unknown'
        };
    }
}

// ✅ НОВОЕ: Отправка данных мониторинга
async sendMonitoringData(eventType = 'activity') {
    if (!this.monitoringEnabled || !this.monitoringEndpoint) {
        return;
    }
    
    try {
        const sessionDuration = Math.floor((new Date() - new Date(this.monitoring.sessionStartTime)) / 1000); // в секундах
        
        const monitoringData = {
            // Идентификаторы
            sessionId: this.sessionId,
            userId: this.extractUserId(),
            userName: this.extractUserName(),
            configName: this.currentConfigName,
            platform: this.platform || 'webchat',  // Берет из настроек или по умолчанию webchat
            
            // Временные метки
            timestamp: new Date().toISOString(),
            sessionStartTime: this.monitoring.sessionStartTime,
            lastActivityTime: this.monitoring.lastActivityTime,
            sessionDuration: sessionDuration,
            
            // Событие
            eventType: eventType, // 'start', 'message', 'activity', 'end'
            
            // Статистика
            messageCount: this.monitoring.messageCount,
            currentLanguage: this.currentLanguage,
            isMinimized: this.isMinimized,
            
            // Информация о пользователе
            userAgent: this.monitoring.userAgent,
            screenResolution: this.monitoring.screenResolution,
            language: this.monitoring.language,
            timezone: this.monitoring.timezone,
            
            // Источник
            referrer: this.monitoring.referrer,
            currentUrl: this.monitoring.currentUrl,
            domain: window.location.hostname,
            
            // Геолокация (будет добавлена асинхронно)
            geo: this.monitoring.geo || null
        };
        
        // Отправляем данные на endpoint
        await this.fetchWithRetry(this.monitoringEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest', // ✅ CSRF защита
                'X-Session-ID': this.sessionId // ✅ Дополнительная идентификация
            },
            body: JSON.stringify(monitoringData)
        });
        
        this.log('debug', '📊 Данные мониторинга отправлены:', eventType);
        
    } catch (error) {
        this.log('error', '❌ Ошибка отправки мониторинга:', error);
    }
}

// ✅ НОВОЕ: Запуск мониторинга
async startMonitoring() {
    if (!this.monitoringEnabled) return;
    
    // Получаем геолокацию при старте
    this.monitoring.geo = await this.getGeoLocation();
    
    // Отправляем событие старта сессии
    await this.sendMonitoringData('start');
    
    // Настраиваем периодическую отправку активности (каждые 30 секунд)
    this.monitoringInterval = setInterval(() => {
        if (!this.isMinimized) {
            this.sendMonitoringData('activity');
        }
    }, 30000);
    
    this.log('info', '📊 Мониторинг запущен');
}

// ✅ НОВОЕ: Остановка мониторинга
stopMonitoring() {
    if (this.monitoringInterval) {
        clearInterval(this.monitoringInterval);
        this.monitoringInterval = null;
    }
    
    // Отправляем событие завершения сессии
    this.sendMonitoringData('end');
    
    this.log('info', '📊 Мониторинг остановлен');
}

    // ==============================================
    // УТИЛИТЫ
    // ==============================================

    // Debounce функция для оптимизации производительности
    debounce(func, delay) {
        let timeoutId;
        return function(...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => func.apply(this, args), delay);
        };
    }

    // Fetch с автоматическими повторными попытками для медленного интернета
    async fetchWithRetry(url, options = {}, maxRetries = 3) {
        let lastError;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const response = await fetch(url, options);

                // Если запрос успешен, возвращаем результат
                if (response.ok || response.status < 500) {
                    return response;
                }

                // Если статус 5xx, пробуем повторить
                lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
                this.log('warn', `⚠️ Попытка ${attempt + 1}/${maxRetries} не удалась:`, lastError.message);

            } catch (error) {
                lastError = error;
                this.log('warn', `⚠️ Сетевая ошибка, попытка ${attempt + 1}/${maxRetries}:`, error.message);
            }

            // Если это не последняя попытка, ждем перед повтором (exponential backoff)
            if (attempt < maxRetries - 1) {
                const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
                this.log('debug', `⏳ Ожидание ${delay}ms перед повтором...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        // Если все попытки исчерпаны, выбрасываем последнюю ошибку
        this.log('error', `❌ Все ${maxRetries} попытки исчерпаны`);
        throw lastError;
    }

    // ==============================================
    // ИНИЦИАЛИЗАЦИЯ
    // ==============================================

    init() {
        this.createChatWidget();
        this.addLinkStyles(); // ✅ НОВОЕ: Добавляем стили для ссылок сразу
        this.setupEventListeners();
        // ✅ НОВОЕ: Настройка обработчиков времени
        this.setupScrollDateHandlers();
        this.updateStatus('connected');

        // ✅ НОВОЕ: Инициализация GDPR системы
        this.initGDPR();

        // ✅ НОВОЕ: Настройка обработчиков Privacy Controls
        setTimeout(() => {
            this.setupGDPRPrivacyControls();
        }, 100);

        // ✅ НОВОЕ: Запуск мониторинга
this.startMonitoring();
        // ✅ НОВОЕ: Мобильная адаптация
        this.adaptForMobile();
        // ✅ НОВОЕ: Отслеживание изменения размера окна
    this.setupResizeHandler();
        // ✅ НОВОЕ: Инициализация viewport height и обработчика ориентации
if (this.isMobileDevice()) {
    this.updateViewportHeight();
    this.setupOrientationHandlers();
}
        this.loadChatHistory();
        // ✅ НОВОЕ: Применяем состояние быстрых кнопок после создания DOM
        setTimeout(() => {
            this.applyQuickButtonsState();
        }, 100);
        
        // ✅ НОВОЕ: Дополнительная прокрутка после полной инициализации
        setTimeout(() => {
            this.scrollToBottom();
            this.log('debug', '📜 Финальная прокрутка после инициализации');
        }, 800);
        
        // Автооткрытие чата
if (this.config.behavior && this.config.behavior.autoOpen) {
    const delay = this.config.behavior.autoOpenDelay || 1000; // По умолчанию 1 секунда
    setTimeout(() => this.toggleChat(), delay);
}
        
        // Автофокус
        if (this.config.behavior && this.config.behavior.autoFocus) {
            setTimeout(() => {
                if (this.messageInput && !this.isMinimized) {
                    this.messageInput.focus();
                }
            }, 100);
        }
        
        // ✅ ИСПРАВЛЕНИЕ: Инициализируем языковые кнопки после полной инициализации
setTimeout(() => {
    if (this.shouldShowLanguageSwitcher()) {
        // ✅ ИСПОЛЬЗУЕМ ПОЛНУЮ ПЕРЕРИСОВКУ ШАПКИ
        this.updateHeaderElements();
        this.log('info', '🌍 Языковые кнопки инициализированы при загрузке');
    }
}, 1000);
        // ✅ НОВОЕ: Инициализация состояния прокрутки для мобильных
        if (this.isMobileDevice() && !this.isMinimized) {
            document.body.style.overflow = 'hidden';
            document.body.style.position = 'fixed';
            document.body.style.width = '100%';
        }
        // ✅ ИСПРАВЛЕНИЕ: Инициализируем языковые кнопки после полной инициализации
setTimeout(() => {
    if (this.shouldShowLanguageSwitcher()) {
        // ✅ ИСПОЛЬЗУЕМ ПОЛНУЮ ПЕРЕРИСОВКУ ШАПКИ
        this.updateHeaderElements();
        this.log('info', '🌍 Языковые кнопки инициализированы при загрузке');
    }
    
    // ✅ НОВОЕ: Обновляем список конфигураций под сохраненный язык
    if (this.configSelect) {
        this.updateConfigSelectOptions();
        this.log('info', '🔄 Список конфигураций обновлен под язык:', this.currentLanguage);
    }
}, 1000);
    }

    // Создание виджета чата
    createChatWidget() {
        const widget = document.createElement('div');
        // ✅ НОВОЕ: При инициализации виджет скрыт, показывается только плавающий виджет
        widget.className = 'webchat-widget webchat-minimized';
        widget.style.display = 'none'; // Скрываем основной виджет при старте
// Проверяем настройку showInputArea
if (this.config.behavior && this.config.behavior.showInputArea === false) {
    widget.classList.add('webchat-hide-input');
}
// Проверяем настройку брендирования
if (!this.shouldShowBranding()) {
    widget.classList.add('webchat-hide-branding');
}
        widget.id = 'webchatWidget';
        // ARIA атрибуты для accessibility
        widget.setAttribute('role', 'complementary');
        widget.setAttribute('aria-label', 'Chat Widget');

        widget.innerHTML = this.generateWidgetHTML();
        document.body.appendChild(widget);
        
        // Сохраняем ссылки на элементы (кэшируем для производительности)
        this.widget = widget;
        this.headerTitle = widget.querySelector('.webchat-header-title');
        this.headerSubtitle = widget.querySelector('.webchat-header-subtitle');
        this.messagesContainer = document.getElementById('webchatMessages');
        this.messageInput = document.getElementById('webchatMessageInput');
        this.statusIndicator = document.getElementById('webchatStatusIndicator');
        this.typingIndicator = document.getElementById('webchatTypingIndicator');
        this.configSelect = document.getElementById('webchatConfigSelect');
        this.voiceBtn = document.getElementById('webchatVoiceBtn');
        this.fileInput = document.getElementById('webchatFileInput');
        this.filePreview = document.getElementById('webchatFilePreview');
        this.fileUploadingIndicator = document.getElementById('webchatFileUploading');
        this.minimizeBtn = widget.querySelector('.webchat-minimize-btn');
        this.popoutBtn = widget.querySelector('.webchat-popout-btn');
        this.contactsPopup = document.getElementById('webchatContactsPopup');
       
        // ✅ НОВОЕ: Применяем тему сразу после создания виджета
        this.applyTheme();
        // ✅ НОВОЕ: Применяем кастомные настройки
        this.applyCustomAppearance();

        // ✅ НОВОЕ: Создаем плавающий виджет
        this.createFloatingWidget();
        // Обновляем видимость виджета
        this.updateFloatingWidgetVisibility();
    }

    // Генерация HTML виджета
// ✅ ИСПРАВЛЕННЫЙ МЕТОД: Генерация HTML виджета с фиксированным порядком
generateWidgetHTML() {
    const quickButtonsHTML = this.generateQuickButtonsHTML();
    const configSelectHTML = this.showConfigSwitcher ? this.generateConfigSelectHTML() : '';
    const languageSwitcherHTML = this.generateLanguageSwitcherHTML();
    const contactsHTML = this.shouldShowContacts() ? this.generateContactsHTML() : '';
    const brandingHTML = this.generateBrandingHTML();

    // ✅ GDPR элементы
    const gdprPrivacyControlsHTML = this.generateGDPRPrivacyControlsHTML();
    const gdprAIDisclosureHTML = this.generateGDPRAIDisclosureHTML();
    const gdprSecurityHTML = this.generateGDPRSecurityHTML();

    return `
    <div class="webchat-header">
        ${this.config.behavior && this.config.behavior.enablePopoutMode ?
            `<button class="webchat-popout-btn" onclick="webChat.openInPopout()" title="${this.texts.interface?.popoutTooltip || 'Открыть в отдельном окне'}">⤢</button>` :
            ''}
        <div class="webchat-status-indicator" id="webchatStatusIndicator"></div>
        <div class="webchat-header-info">
            <div class="webchat-header-title">${this.config.botInfo.avatar} ${this.texts.headerTitle}</div>
            <div class="webchat-header-subtitle-row">
                <span class="webchat-header-subtitle">${this.texts.headerSubtitle}</span>
                ${gdprAIDisclosureHTML}
                ${gdprSecurityHTML}
            </div>
        </div>
        ${configSelectHTML}
        ${languageSwitcherHTML}
        ${contactsHTML}
        ${gdprPrivacyControlsHTML}
        <button class="webchat-minimize-btn" onclick="webChat.toggleChat()" title="${this.texts.interface.expand}" aria-label="${this.texts.interface.expand}" aria-expanded="false">+</button>
    </div>

        <div class="webchat-messages" id="webchatMessages" role="log" aria-live="polite" aria-relevant="additions">
            ${this.config.behavior && this.config.behavior.showWelcome ? this.generateWelcomeMessage() : ''}
        </div>

       <div class="webchat-typing-indicator" id="webchatTypingIndicator">
    ${this.texts.interface.typingIndicator}
    <span class="webchat-typing-dots">
        <span class="webchat-typing-dot"></span>
        <span class="webchat-typing-dot"></span>
        <span class="webchat-typing-dot"></span>
    </span>
</div>

        <div class="webchat-input-area">
            ${this.config.behavior && this.config.behavior.showQuickButtons ? quickButtonsHTML : ''}
            
            <div class="webchat-file-preview" id="webchatFilePreview">
    <div class="webchat-file-preview-header">
        <span class="webchat-file-preview-label">${this.texts.interface?.selectedFile || 'Выбранный файл:'}</span>
        <button class="webchat-file-preview-close" onclick="webChat.clearFile()" title="${this.texts.interface?.removeFile || 'Убрать файл'}">×</button>
    </div>
    <div class="webchat-file-preview-content" id="webchatFilePreviewContent">
        <!-- Содержимое генерируется динамически -->
    </div>
</div>
            
            <div class="webchat-file-uploading" id="webchatFileUploading">
                <div class="webchat-file-uploading-spinner"></div>
                <span>${this.texts.interface.fileUploading}</span>
            </div>
            
            <div class="webchat-input-controls">
                <input type="file" class="webchat-file-input" id="webchatFileInput" accept="image/*,application/pdf,.doc,.docx,.txt,.csv,.xls,.xlsx" aria-label="Upload file">
                <textarea class="webchat-message-input" id="webchatMessageInput"
                         placeholder="${this.texts.interface.placeholder}"
                         rows="1"
                         maxlength="${this.config.technical ? this.config.technical.maxMessageLength : 1000}"
                         aria-label="Type your message"></textarea>
                ${this.config.behavior && this.config.behavior.enableVoice ? `<button class="webchat-control-btn" id="webchatVoiceBtn" onclick="webChat.toggleVoiceRecording()" title="${this.texts.interface.voiceTooltip}" aria-label="Voice input">🎤</button>` : ''}
                ${this.fileSettings.enableFileUpload ? `<button class="webchat-file-btn" id="webchatFileBtn" onclick="webChat.selectFile()" title="${this.texts.interface.fileTooltip}" aria-label="Attach file">📎</button>` : ''}
                <button class="webchat-control-btn" onclick="webChat.sendMessage()" title="${this.texts.interface.sendTooltip}" aria-label="Send message">📤</button>
            </div>
        </div>

        ${brandingHTML}
    `;
}

// ✅ ИСПРАВЛЕННЫЙ МЕТОД: Обновление отображения переключателя языков
updateLanguageSwitcherDisplay() {
    this.log('debug', '🔄 Обновление отображения переключателя языков');
    
    // ✅ ПОЛНАЯ ПЕРЕРИСОВКА ШАПКИ для консистентности
    this.updateHeaderElements();
}

// ✅ НОВЫЙ МЕТОД: Полное обновление элементов шапки
updateHeaderElements() {
    const header = this.widget.querySelector('.webchat-header');
    if (!header) return;
    
    // Сохраняем состояние кнопки сворачивания
    const isMinimized = this.isMinimized;
    const minimizeBtn = header.querySelector('.webchat-minimize-btn');
    const currentMinimizeText = minimizeBtn ? minimizeBtn.textContent : (isMinimized ? '+' : '−');
    const currentMinimizeTitle = minimizeBtn ? minimizeBtn.title : (isMinimized ? this.texts.interface.expand : this.texts.interface.minimize);
    
    // Генерируем новую структуру шапки
    const configSelectHTML = this.showConfigSwitcher ? this.generateConfigSelectHTML() : '';
    const languageSwitcherHTML = this.shouldShowLanguageSwitcher() ? this.generateLanguageSwitcherHTML() : '';
    const contactsHTML = this.shouldShowContacts() ? this.generateContactsHTML() : '';
    
    // ✅ ФИКСИРОВАННЫЙ ПОРЯДОК: статус → info → конфиг → языки → контакты → сворачивание
header.innerHTML = `
    ${this.config.behavior && this.config.behavior.enablePopoutMode ? 
        `<button class="webchat-popout-btn" onclick="webChat.openInPopout()" title="${this.texts.interface?.popoutTooltip || 'Открыть в отдельном окне'}"></button>`: 
        ''}
    <div class="webchat-status-indicator" id="webchatStatusIndicator"></div>
    <div class="webchat-header-info">
        <div class="webchat-header-title">${this.config.botInfo.avatar} ${this.texts.headerTitle}</div>
        <div class="webchat-header-subtitle">${this.texts.headerSubtitle}</div>
    </div>
    ${configSelectHTML}
    ${languageSwitcherHTML}
    ${contactsHTML}
    <button class="webchat-minimize-btn" onclick="webChat.toggleChat()" title="${currentMinimizeTitle}" aria-label="${currentMinimizeTitle}" aria-expanded="${!isMinimized}">${currentMinimizeText}</button>
`;
    
    // Обновляем ссылки на элементы
    this.statusIndicator = document.getElementById('webchatStatusIndicator');
    this.headerTitle = header.querySelector('.webchat-header-title');
    this.headerSubtitle = header.querySelector('.webchat-header-subtitle');
    this.configSelect = document.getElementById('webchatConfigSelect');
    this.contactsPopup = document.getElementById('webchatContactsPopup');
    this.minimizeBtn = header.querySelector('.webchat-minimize-btn');
    
    // Перенастраиваем обработчики
    if (this.configSelect) {
        this.setupConfigSelectEvents();
    }
    if (this.contactsPopup) {
        this.setupContactsEvents();
    }
    
    // Обновляем состояние кнопок языков
    if (this.shouldShowLanguageSwitcher()) {
        this.updateLanguageButtons();
    }
    
    this.log('info', '✅ Элементы шапки полностью обновлены с фиксированным порядком');
}

// ✅ ИСПРАВЛЕННЫЙ МЕТОД: Обновление отображения контактов
updateContactsDisplay() {
    this.log('debug', '🔄 Обновление контактов через полную перерисовку шапки');
    
    // ✅ ИСПОЛЬЗУЕМ НОВЫЙ МЕТОД ПОЛНОЙ ПЕРЕРИСОВКИ
    this.updateHeaderElements();
}

// ✅ ИСПРАВЛЕННЫЙ МЕТОД: Обновление интерфейса
updateInterface() {
    // Обновляем заголовок (используем кэшированные элементы)
    if (this.headerTitle) this.headerTitle.textContent = this.texts.headerTitle;
    if (this.headerSubtitle) this.headerSubtitle.textContent = this.texts.headerSubtitle;
    
    // Обновляем плейсхолдер
    if (this.messageInput) {
        this.messageInput.placeholder = this.texts.interface && this.texts.interface.placeholder ? this.texts.interface.placeholder : "Введите сообщение...";
    }
    
    // Обновляем быстрые кнопки
    this.updateQuickButtons();
    
    // ✅ ПОЛНАЯ ПЕРЕРИСОВКА ШАПКИ вместо отдельных обновлений
    this.updateHeaderElements();
    
    // ✅ НОВОЕ: Проверяем и обновляем тему если нужно
    const expectedTheme = this.determineTheme();
    if (this.currentTheme !== expectedTheme) {
        this.currentTheme = expectedTheme;
        this.applyTheme();
        this.log('debug', '🎨 Тема обновлена при смене интерфейса:', expectedTheme);
    }
    
    // ✅ НОВОЕ: Обновляем все интерфейсные тексты после смены языка
    this.updateInterfaceTexts();
    
    // ✅ НОВОЕ: Синхронизируем состояние быстрых кнопок с конфигурацией
    this.quickButtonsCollapsed = this.config.behavior && this.config.behavior.quickButtonsCollapsed === true;
    
    
}

    // ✅ УЛУЧШЕННОЕ: Генерация выпадающего списка конфигураций с проверкой доступности
generateConfigSelectHTML() {
    // Если переключатель отключен, возвращаем пустую строку
    if (!this.showConfigSwitcher) {
        return '';
    }
    
    const sortedConfigs = this.getSortedConfigsForUI(this.currentLanguage);
    
    // Если доступна только одна конфигурация, не показываем переключатель
    if (sortedConfigs.length === 0) {
        this.log('warn','⚠️ Нет доступных конфигураций для отображения переключателя');
        return '';
    }

    // Если доступна только одна конфигурация, не показываем переключатель
    if (sortedConfigs.length <= 1) {
        return '';
    }

    const options = sortedConfigs.map(config => {
        const selected = config.value === this.currentConfigName ? ' selected' : '';
        return `<option value="${config.value}"${selected}>${config.label}</option>`;
    }).join('');

    const switcherTitle = this.texts.switcher?.tooltip || 
                 (window.GlobalConfigSettings?.configSwitcher?.title) || 
                 'Сменить специалиста';

    return `
        <div class="webchat-config-switcher">
            <select class="webchat-config-select" id="webchatConfigSelect" onchange="webChat.switchConfig(this.value)" title="${switcherTitle}">
                ${options}
            </select>
        </div>
    `;
}

// ✅ ИСПРАВЛЕННЫЙ МЕТОД: Генерация выпадающего переключателя языков (ТОЛЬКО ФЛАГ)
generateLanguageSwitcherHTML() {
    if (!this.showLanguageSwitcher) {
        return '';
    }
    
    const supportedLanguages = this.getSupportedLanguages();
    if (supportedLanguages.length <= 1) {
        return '';
    }
    
    const currentLanguage = this.currentLanguage || this.config.language || 'ru';
    const otherLanguages = supportedLanguages.filter(lang => lang !== currentLanguage);
    const currentFlag = this.getLanguageIcon(currentLanguage);
    
    // ✅ ДИНАМИЧЕСКАЯ ПОДСКАЗКА
    const languageTooltip = this.texts.interface?.selectLanguage || 'Выбрать язык';
    
    const dropdownOptions = otherLanguages.map(lang => {
        const icon = this.getLanguageIcon(lang);
        const tooltip = this.getLanguageTooltip(lang);
        
        return `<div class="webchat-language-option" 
                     data-language="${lang}" 
                     onclick="webChat.switchLanguage('${lang}')" 
                     title="${tooltip}">
                    <span class="webchat-language-option-icon">${icon}</span>
                    <span class="webchat-language-option-text">${tooltip}</span>
                </div>`;
    }).join('');
    
    return `
        <div class="webchat-language-dropdown" style="display: ${this.isMinimized ? 'none' : 'flex'};">
            <button class="webchat-language-toggle-btn" 
                    onclick="webChat.toggleLanguageDropdown()" 
                    title="${languageTooltip}">
                <span class="webchat-current-language">${currentFlag}</span>
                <span class="webchat-dropdown-arrow">▼</span>
            </button>
            <div class="webchat-language-dropdown-menu">
                ${dropdownOptions}
            </div>
        </div>
    `;
}

// ✅ НОВЫЙ: Получение настроек иконок
getLanguageIconSettings() {
    try {
        if (window.GlobalConfigSettings && 
            window.GlobalConfigSettings.languageSettings && 
            window.GlobalConfigSettings.languageSettings.iconSettings) {
            return window.GlobalConfigSettings.languageSettings.iconSettings;
        }
        
        return {
            type: 'flags',
            showTooltips: true,
            customIcons: { 'ru': '🇷🇺', 'en': '🇺🇸' }
        };
    } catch (error) {
        return { type: 'flags', showTooltips: true, customIcons: {} };
    }
}

// ✅ ИСПРАВЛЕННЫЙ: Получение иконки для языка
getLanguageIcon(language, iconSettings) {
    try {
        const settings = iconSettings || this.getLanguageIconSettings();
        
        // 1. Сначала проверяем кастомные иконки из настроек
        if (settings.customIcons && settings.customIcons[language]) {
            this.log('debug', `✅ Найдена кастомная иконка для ${language}:`, settings.customIcons[language]);
            return settings.customIcons[language];
        }
        
        // 2. Дефолтные флаги (обязательно должны быть)
        const defaultFlags = {
            'ru': '🇷🇺', 
            'en': '🇺🇸', 
            'es': '🇪🇸', 
            'fr': '🇫🇷', 
            'de': '🇩🇪',
            'it': '🇮🇹', 
            'pt': '🇵🇹', 
            'zh': '🇨🇳', 
            'ja': '🇯🇵', 
            'ko': '🇰🇷',
            'ua': '🇺🇦',
            'ar': '🇸🇦',
            'hi': '🇮🇳',
            'tr': '🇹🇷',
            'pl': '🇵🇱'
        };
        
        if (defaultFlags[language]) {
            this.log('debug', `✅ Найден дефолтный флаг для ${language}:`, defaultFlags[language]);
            return defaultFlags[language];
        }
        
        // 3. Fallback - глобус
        this.log('warn', `⚠️ Флаг не найден для языка ${language}, используем глобус`);
        return '🌐';
        
    } catch (error) {
        this.log('error', '❌ Ошибка получения иконки языка:', error);
        return language.toUpperCase(); // Последний fallback - текст
    }
}


// ✅ УПРОЩЕННЫЙ getLanguageTooltip - только из конфига!
getLanguageTooltip(language, iconSettings) {
    try {
        const settings = iconSettings || this.getLanguageIconSettings();
        
        // 🚫 Если подсказки отключены
        if (!settings.showTooltips) {
            return '';
        }
        
        const currentInterfaceLanguage = this.currentLanguage || 'ru';
        
        // 📍 ПРИОРИТЕТ 1: Названия из GlobalConfigSettings (ОСНОВНОЙ ИСТОЧНИК)
        if (settings.languageNames && 
            settings.languageNames[language] && 
            settings.languageNames[language][currentInterfaceLanguage]) {
            return settings.languageNames[language][currentInterfaceLanguage];
        }
        
        // 📍 ПРИОРИТЕТ 2: Fallback - код языка заглавными буквами
        return language.toUpperCase();
        
    } catch (error) {
        this.log('error','❌ Ошибка получения названия языка:', error);
        return language.toUpperCase();
    }
}
    // ✅ НОВОЕ: Получение текущего имени конфигурации через configId
getCurrentConfigName() {
    // Приоритет 1: Используем configId если есть
    if (this.config.configId) {
        this.log('debug', '✅ Конфигурация определена по configId:', this.config.configId);
        return this.config.configId;
    }
    
    // Приоритет 2: Ищем конфигурацию по совпадению объекта
    const availableConfigs = this.getAvailableConfigs();
    for (let configName in availableConfigs) {
        if (availableConfigs[configName] === this.config) {
            this.log('debug', '✅ Конфигурация определена по объекту:', configName);
            return configName;
        }
    }
    
    // Приоритет 3: Возвращаем первую доступную конфигурацию
    const configNames = Object.keys(availableConfigs);
    if (configNames.length > 0) {
        this.log('warn', '⚠️ Не удалось определить текущую конфигурацию, используем первую доступную');
        return configNames[0];
    }
    
    // Критический fallback
    this.log('error', '❌ Не найдено ни одной конфигурации!');
    return 'defaultConfig';
}

// Генерация приветственного сообщения
    generateWelcomeMessage() {
        return `
            <div class="webchat-message webchat-bot">
                <div class="webchat-message-avatar webchat-bot-avatar">${this.config.botInfo.avatar}</div>
                <div class="webchat-message-content">${this.texts.welcomeMessage}</div>
            </div>
        `;
    }

    // Генерация быстрых кнопок
    // ✅ ИСПРАВЛЕННОЕ: Генерация быстрых кнопок с дополнительными проверками
generateQuickButtonsHTML() {
    // Проверяем основные настройки
    if (!this.config.behavior || !this.config.behavior.showQuickButtons) {
        return '';
    }
    
    // Проверяем наличие метода getQuickButtons
    if (typeof this.config.getQuickButtons !== 'function') {
        this.log('warn','⚠️ Метод getQuickButtons не найден в конфигурации');
        return '';
    }
    
    // Получаем кнопки с проверкой
    let buttons;
    try {
        buttons = this.config.getQuickButtons();
    } catch (error) {
        this.log('error','❌ Ошибка вызова getQuickButtons():', error);
        return '';
    }
    
    // Проверяем что buttons это массив
    if (!buttons || !Array.isArray(buttons) || buttons.length === 0) {
        
        return '';
    }
    
    // Остальная часть метода остается без изменений...
        
       // ✅ ИСПРАВЛЕНО: Проверяем правильное состояние свернутости
const isCollapsed = this.quickButtonsCollapsed;
const collapsedClass = isCollapsed ? ' webchat-quick-collapsed' : '';
const toggleIcon = isCollapsed ? '▲' : '▼';
const toggleTitle = isCollapsed ? 
    (this.texts.quickButtons?.toggleShow || 'Показать быстрые команды') : 
    (this.texts.quickButtons?.toggleHide || 'Скрыть быстрые команды');
    
       const buttonsHTML = buttons.map(btn => {
    // ✅ Двойная защита: escapeHTML + замена опасных символов для onclick
    const safeMessage = this.escapeHTML(btn.message)
        .replace(/'/g, '&#39;')   // Одинарные кавычки
        .replace(/"/g, '&quot;')  // Двойные кавычки
        .replace(/\\/g, '&#92;'); // Обратный слэш
    
    const safeText = this.escapeHTML(btn.text);
    
    return `<button class="webchat-quick-btn" onclick="webChat.sendQuickMessage('${safeMessage}')">${safeText}</button>`;
}).join('');
        
        return `
            <div class="webchat-quick-actions${collapsedClass}">
                <div class="webchat-quick-actions-header">
                    <span class="webchat-quick-actions-title">${this.texts.quickButtons?.title || 'Быстрые команды'}</span>
                    <button class="webchat-quick-toggle-btn" onclick="webChat.toggleQuickButtons()" title="${toggleTitle}">
                        ${toggleIcon}
                    </button>
                </div>
                <div class="webchat-quick-buttons">
                    ${buttonsHTML}
                </div>
            </div>
        `;
    }

    // ✅ НОВОЕ: Проверка отображения брендирования
    shouldShowBranding() {
        // Проверяем есть ли настройки брендирования в конфигурации
        if (!this.config.branding) {
            return false;
        }

        // Проверяем включен ли брендинг
        if (this.config.branding.enabled === false) {
            return false;
        }

        return true;
    }

    // ✅ НОВОЕ: Генерация HTML брендирования
    generateBrandingHTML() {
        // Если брендирование отключено, возвращаем пустую строку
        if (!this.shouldShowBranding()) {
            return '';
        }

        const branding = this.config.branding;

        // Определяем тип логотипа
        const logoType = branding.logoType || 'svg';

        // Размеры по умолчанию
        const defaultSize = {
            logoWidth: 32,
            logoHeight: 32,
            fontSize: 12
        };

        const size = Object.assign({}, defaultSize, branding.size || {});

        // Генерируем HTML логотипа
        let logoHTML = '';

        if (logoType === 'svg' && branding.logoSvg) {
            // SVG логотип
            logoHTML = `<div class="webchat-branding-logo" style="width: ${size.logoWidth}px; height: ${size.logoHeight}px;">
                ${branding.logoSvg}
            </div>`;
        } else if (logoType === 'icon' && branding.icon) {
            // Иконка (emoji или символ)
            logoHTML = `<div class="webchat-branding-icon" style="font-size: ${size.logoWidth * 0.8}px;">
                ${branding.icon}
            </div>`;
        } else if (logoType === 'image' && branding.imageUrl) {
            // URL изображения
            logoHTML = `<div class="webchat-branding-logo" style="width: ${size.logoWidth}px; height: ${size.logoHeight}px;">
                <img src="${branding.imageUrl}" alt="${branding.companyName || 'Logo'}" style="width: 100%; height: 100%; object-fit: contain;">
            </div>`;
        }

        // Текст брендирования
        const poweredByText = (branding.poweredByText || '').trim();
        const companyName = branding.companyName || 'Company';
        const companyUrl = (branding.companyUrl || '').trim();

        // Генерируем HTML для "Powered by" текста (если есть)
        const poweredByHTML = poweredByText ?
            `<span class="webchat-branding-powered" style="font-size: ${size.fontSize}px !important;">${poweredByText}</span>` : '';

        // Генерируем HTML для названия компании (с ссылкой или без)
        let companyNameHTML = `<span class="webchat-branding-company" style="font-size: ${size.fontSize}px !important;">${companyName}</span>`;

        if (companyUrl) {
            // Если есть URL, оборачиваем в ссылку с сохранением стилей
            companyNameHTML = `<a href="${companyUrl}" target="_blank" rel="noopener noreferrer" style="text-decoration: none; color: inherit;">
                <span class="webchat-branding-company" style="font-size: ${size.fontSize}px !important;">${companyName}</span>
            </a>`;
        }

        // Генерируем HTML текста
        const textHTML = `<div class="webchat-branding-text">
            ${poweredByHTML}
            ${companyNameHTML}
        </div>`;

        // Собираем весь HTML брендирования
        return `
            <div class="webchat-branding-container">
                ${logoHTML}
                ${textHTML}
            </div>
        `;
    }

    // ═══════════════════════════════════════════════════════════
    // GDPR UI GENERATORS
    // ═══════════════════════════════════════════════════════════

    generateGDPRPrivacyControlsHTML() {
        if (!this.gdprManager || !this.config.gdpr?.enabled) return '';
        if (!this.config.gdpr?.privacyControls?.enabled) return '';
        if (!this.config.gdpr?.privacyControls?.showInHeader) return '';

        return this.gdprManager.renderPrivacyControls();
    }

    generateGDPRAIDisclosureHTML() {
        if (!this.gdprManager || !this.config.gdpr?.enabled) return '';
        if (!this.config.gdpr?.aiDisclosure?.enabled) return '';
        if (!this.config.gdpr?.aiDisclosure?.showBadge) return '';

        return this.gdprManager.renderAIDisclosure();
    }

    generateGDPRSecurityHTML() {
        if (!this.gdprManager || !this.config.gdpr?.enabled) return '';
        if (!this.config.gdpr?.securityIndicators?.showSecureBadge) return '';

        return this.gdprManager.renderSecurityIndicator();
    }

    setupGDPRPrivacyControls() {
        if (this.gdprManager && this.config.gdpr?.privacyControls?.enabled) {
            this.gdprManager.setupPrivacyControlsListeners();
        }
    }

    // ✅ УЛУЧШЕННОЕ: Переключение конфигурации с проверкой доступности
switchConfig(configName) {
    this.log('info', '🔄 Переключение на конфигурацию:', configName);
    // Проверяем что конфигурация доступна
    if (!this.availableConfigs[configName]) {
        this.log('error', '❌ Конфигурация недоступна:', configName);
        return;
    }
    const newConfig = this.availableConfigs[configName];
    // Если это та же конфигурация, ничего не делаем
    if (configName === this.currentConfigName) {
        return;
    }

    // Показываем уведомление о переключении
    this.addMessage(
        `🔄 ${this.texts.system.switching || 'Переключаюсь на'} <strong>${newConfig.botInfo.name}</strong>...<br>
         <small>${this.texts.system.nowServing || 'Теперь вас обслуживает'} ${newConfig.botInfo.description}</small>`,
        'bot'
    );
    setTimeout(() => {
        this.clearSwitchingMessages();
    }, 1000);

    // ✅ НОВОЕ: Очищаем старые стили перед применением новых
    this.clearOldStyles();
    
    // Сохраняем текущую конфигурацию
    this.currentConfigName = configName;
    // Применяем новую конфигурацию
    this.config = Object.assign({}, newConfig);
    // ✅ ИСПРАВЛЕНИЕ: Обновляем язык ПЕРЕД получением текстов
    const oldLanguage = this.currentLanguage;
    this.currentLanguage = this.config.language;
    this.log('info', `🌍 Язык обновлен: ${oldLanguage} → ${this.currentLanguage}`);
    // ✅ ТЕПЕРЬ получаем тексты с уже обновленным языком
    this.texts = this.config.getTexts ? this.config.getTexts() : this.config.texts[this.config.language] || this.config.texts.ru;
    this.quickButtonsCollapsed = this.config.behavior && this.config.behavior.quickButtonsCollapsed === true;
    this.log('info', `🆔 Session ID остается неизменным: ${this.sessionId}`);
    this.currentTheme = this.determineTheme();
    this.applyTheme();
    this.updateContactsDisplay();
    
    // ✅ НОВОЕ: Применяем ВСЕ настройки конфигурации
    this.applyAllConfigSettings();
    
    // Обновляем интерфейс
    setTimeout(() => {
        this.updateInterface();
        // Если язык изменился, обновляем все языковые элементы
        if (oldLanguage !== this.currentLanguage) {
            this.updateLanguageButtons();
            if (this.configSelect) {
                this.updateConfigSelectOptions();
            }
        }
        this.reinitializeFileHandlers();

        // ✅ СБРАСЫВАЕМ КЭШ первых строк
        this.cachedWelcomeLines = null;

        this.clearWelcomeMessages();
        this.clearDuplicateDateHeaders();

        if (this.config.behavior && this.config.behavior.showWelcome) {
            this.addMessage(this.texts.welcomeMessage, 'bot');
            
            // ✅ ДОПОЛНИТЕЛЬНАЯ ОЧИСТКА дат после добавления приветствия
            setTimeout(() => {
                this.clearDuplicateDateHeaders();
            }, 100);
            
            this.log('info', '👋 Показано приветственное сообщение (showWelcome: true)');
        } else {
            this.log('info', '🚫 Приветственное сообщение скрыто (showWelcome: false)');
        }

        // ✅ ПРИНУДИТЕЛЬНЫЙ ПОЛНЫЙ СБРОС ДАТА-СИСТЕМЫ
        this.forceResetDateSystem();

        // ✅ Обновляем аватары во всех существующих сообщениях
        this.updateBotAvatarsInMessages();

    }, 1000);

    this.log('info', '✅ Переключение завершено на:', newConfig.botInfo.name, 'с темой:', this.currentTheme);
}

// ✅ НОВЫЙ МЕТОД: Обновление аватаров бота во всех сообщениях
updateBotAvatarsInMessages() {
    if (!this.messagesContainer) return;

    const newAvatar = this.config.botInfo.avatar;
    const botAvatars = this.messagesContainer.querySelectorAll('.webchat-bot-avatar');

    if (botAvatars.length > 0) {
        this.log('info', `🔄 Обновление ${botAvatars.length} аватаров бота на: ${newAvatar}`);
        botAvatars.forEach(avatar => {
            avatar.textContent = newAvatar;
        });
    }
}

// ✅ НОВЫЙ МЕТОД: Применение всех настроек конфигурации
applyAllConfigSettings() {
    // Сохраняем текущее состояние для сравнения
    this.previousShowWelcome = this.config.behavior?.showWelcome;
    
    // 1. Применяем настройки поведения
    this.applyBehaviorSettings();
    
    // 2. Применяем настройки внешнего вида
    this.applyAppearanceSettings();
    
    // 3. Применяем кастомные настройки
    this.applyCustomAppearance();
    
    // 4. Обновляем видимость элементов
    this.updateElementsVisibility();
    
    // 5. Перерисовываем быстрые кнопки если нужно
    if (this.config.behavior?.showQuickButtons) {
        this.updateQuickButtons();
    }

    // 6. ✅ ИСПРАВЛЕНИЕ: Всегда пересоздаем плавающий виджет с новыми настройками конфигурации
    this.createFloatingWidget();
    this.updateFloatingWidgetVisibility();

    this.log('info', '✅ Все настройки конфигурации применены');
}

// ✅ НОВЫЙ МЕТОД: Применение настроек поведения
applyBehaviorSettings() {
    if (!this.config.behavior) return;
    
    const behavior = this.config.behavior;
    
    // 1. Обновляем состояние области ввода
    if (this.widget) {
        if (behavior.showInputArea === false) {
            this.widget.classList.add('webchat-hide-input');
        } else {
            this.widget.classList.remove('webchat-hide-input');
        }

        // Обновляем класс брендирования
        if (!this.shouldShowBranding()) {
            this.widget.classList.add('webchat-hide-branding');
        } else {
            this.widget.classList.remove('webchat-hide-branding');
        }
    }

    // 2. Обновляем видимость быстрых кнопок
    const quickActions = this.widget.querySelector('.webchat-quick-actions');
    if (quickActions) {
        if (behavior.showQuickButtons === false) {
            quickActions.style.display = 'none';
        } else {
            quickActions.style.display = '';
            // Обновляем состояние свернутости
            this.quickButtonsCollapsed = behavior.quickButtonsCollapsed || false;
            this.applyQuickButtonsState();
        }
    }
    
    // 3. Обновляем видимость кнопки popout
    if (this.popoutBtn) {
        if (behavior.enablePopoutMode && !this.isMinimized) {
            this.popoutBtn.style.display = 'flex';
        } else {
            this.popoutBtn.style.display = 'none';
        }
    }
    
    // 4. Обновляем видимость кнопки голоса
    if (this.voiceBtn) {
        if (behavior.enableVoice) {
            this.voiceBtn.style.display = 'flex';
        } else {
            this.voiceBtn.style.display = 'none';
        }
    }
    
    // 5. Обновляем видимость кнопки файлов
    const fileBtn = this.widget.querySelector('.webchat-file-btn');
    if (fileBtn) {
        if (behavior.enableFileUpload) {
            fileBtn.style.display = 'flex';
        } else {
            fileBtn.style.display = 'none';
        }
    }
    
    // 6. Обновляем настройки файлов
    this.fileSettings = {
        maxFileSize: this.config.technical?.maxFileSize || 10 * 1024 * 1024,
        allowedTypes: this.config.technical?.allowedFileTypes || [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
            'application/pdf', 'text/plain', 'text/csv',
            'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ],
        enablePasteImages: behavior.enablePasteImages !== false,
        enableFileUpload: behavior.enableFileUpload !== false
    };
    
    // 7. Обновляем обработчики файлов если изменились настройки
    if (behavior.enableFileUpload || behavior.enablePasteImages) {
        this.reinitializeFileHandlers();
    } else {
        this.removeFileHandlers();
    }
    
    // 8. Обновляем автофокус
    if (behavior.autoFocus && !this.isMinimized) {
        setTimeout(() => {
            if (this.messageInput) {
                this.messageInput.focus();
            }
        }, 100);
    }
    
    // 9. Обновляем настройки истории
    // Эти настройки применятся при следующем сохранении
    
    // 10. Обновляем приветственное сообщение
    if (behavior.showWelcome !== this.previousShowWelcome) {
        this.handleWelcomeMessageChange(behavior.showWelcome);
        this.previousShowWelcome = behavior.showWelcome;
    }
}

// ✅ НОВЫЙ МЕТОД: Обработка изменения показа приветственного сообщения
handleWelcomeMessageChange(showWelcome) {
    const existingWelcome = this.messagesContainer.querySelector('.webchat-message.webchat-bot:first-child');
    
    if (showWelcome && !existingWelcome) {
        // Добавляем приветственное сообщение
        const firstMessage = this.messagesContainer.firstChild;
        const welcomeHTML = this.generateWelcomeMessage();
        if (firstMessage) {
            firstMessage.insertAdjacentHTML('beforebegin', welcomeHTML);
        } else {
            this.messagesContainer.innerHTML = welcomeHTML;
        }
    } else if (!showWelcome && existingWelcome) {
        // Удаляем приветственное сообщение
        const welcomeText = this.texts.welcomeMessage;
        if (existingWelcome.innerHTML.includes(welcomeText)) {
            existingWelcome.remove();
        }
    }
}

// ✅ НОВЫЙ МЕТОД: Обновление видимости элементов
updateElementsVisibility() {
    const messagesContainer = this.widget.querySelector('.webchat-messages');
    const inputArea = this.widget.querySelector('.webchat-input-area');
    
    if (!this.config.behavior) return;
    
    // Обновляем высоту контейнера сообщений при скрытии области ввода
    if (messagesContainer && inputArea) {
        if (this.config.behavior.showInputArea === false) {
            messagesContainer.style.height = 'calc(100% - 60px)'; // Только шапка
        } else {
            messagesContainer.style.height = ''; // Сбрасываем на стандартную
        }
    }
}

// ✅ НОВЫЙ МЕТОД: Очистка старых стилей
clearOldStyles() {
    // Удаляем старые стили кнопок
    const oldButtonStyles = document.getElementById('webchat-button-colors');
    if (oldButtonStyles) {
        oldButtonStyles.remove();
    }
    
    // Удаляем другие динамические стили
    const dynamicStyles = document.querySelectorAll('style[data-webchat-dynamic="true"]');
    dynamicStyles.forEach(style => style.remove());
}

// ✅ НОВЫЙ МЕТОД: Применение размеров виджета
applyWidgetDimensions() {
    if (!this.widget || !this.config.appearance) return;

    const appearance = this.config.appearance;

    // Применяем размеры только если чат развернут
    if (!this.isMinimized) {
        // Очищаем inline стили если это не компактный режим
        if (!this.isCompactMode) {
            this.widget.style.width = appearance.dimensions.width + 'px';
            this.widget.style.height = appearance.dimensions.height + 'px';
            this.widget.style.maxWidth = appearance.dimensions.width + 'px';
            this.widget.style.maxHeight = appearance.dimensions.height + 'px';
        }
    }
}

    // Обновление интерфейса после переключения
    updateInterface() {
    // Обновляем заголовок (используем кэшированные элементы)
    if (this.headerTitle) this.headerTitle.textContent = this.texts.headerTitle;
    if (this.headerSubtitle) this.headerSubtitle.textContent = this.texts.headerSubtitle;
    
    // Обновляем плейсхолдер
    if (this.messageInput) {
        this.messageInput.placeholder = this.texts.interface && this.texts.interface.placeholder ? this.texts.interface.placeholder : "Введите сообщение...";
    }
    
    // Обновляем быстрые кнопки
    this.updateQuickButtons();
    
    // Обновляем выбранную опцию в селекте
    if (this.configSelect && this.showConfigSwitcher) {
        this.configSelect.value = this.currentConfigName;
    }
    
    // ✅ НОВОЕ: Проверяем и обновляем тему если нужно
    const expectedTheme = this.determineTheme();
    if (this.currentTheme !== expectedTheme) {
        this.currentTheme = expectedTheme;
        this.applyTheme();
        this.log('debug', '🎨 Тема обновлена при смене интерфейса:', expectedTheme);
    }
    
    // ✅ ИСПРАВЛЕНО: Обновляем контакты ПРИ КАЖДОЙ смене конфигурации
    this.updateContactsDisplay();
    
    // ✅ НОВОЕ: Обновляем все интерфейсные тексты после смены языка
    this.updateInterfaceTexts();
    // ✅ НОВОЕ: Синхронизируем состояние быстрых кнопок с конфигурацией
this.quickButtonsCollapsed = this.config.behavior && this.config.behavior.quickButtonsCollapsed === true;
// Обновляем видимость кнопки popout
if (this.popoutBtn) {
    if (this.config.behavior && this.config.behavior.enablePopoutMode) {
        this.popoutBtn.style.display = 'flex';
    } else {
        this.popoutBtn.style.display = 'none';
    }
}

}
// ✅ МЕТОД 1: Обновленный updateInterfaceTexts с подсказками
updateInterfaceTexts() {
    // 1. ✅ Кнопка сворачивания/разворачивания
    if (this.minimizeBtn) {
        this.minimizeBtn.title = this.isMinimized ? 
            this.texts.interface.expand : 
            this.texts.interface.minimize;
    }
    
   // Обновление tooltip для кнопки popout
const popoutBtn = this.widget.querySelector('.webchat-popout-btn');
if (popoutBtn) {
    popoutBtn.title = this.texts.interface?.popoutTooltip || 'Открыть в отдельном окне';
    // Обновляем видимость при смене языка
    if (this.isMinimized) {
        popoutBtn.style.display = 'none';
    } else {
        popoutBtn.style.display = 'flex';
    }
}
    
    // 2. ✅ Переключатель конфигураций
    if (this.configSelect) {
        this.configSelect.title = this.texts.switcher?.tooltip || 'Switch specialist';
    }
    
    // 3. ✅ Кнопка контактов
    const contactsBtn = this.widget.querySelector('.webchat-contacts-btn');
    if (contactsBtn) {
        const contactsTooltip = this.texts.contacts?.tooltip || this.config.contacts?.title || 'Contacts';
        contactsBtn.title = contactsTooltip;
    }
    
    // 4. ✅ Переключатель языков
    const languageToggleBtn = this.widget.querySelector('.webchat-language-toggle-btn');
    if (languageToggleBtn) {
        const languageTooltip = this.texts.interface?.selectLanguage || 'Выбрать язык';
        languageToggleBtn.title = languageTooltip;
    }
    
    // 5. ✅ Кнопка голосового сообщения
    if (this.voiceBtn) {
        this.voiceBtn.title = this.texts.interface.voiceTooltip;
    }
    
    // 6. ✅ Кнопка прикрепления файла
    const fileBtn = this.widget.querySelector('.webchat-file-btn');
    if (fileBtn) {
        fileBtn.title = this.texts.interface.fileTooltip;
    }
    
    // 7. ✅ Кнопка отправки сообщения
    const sendBtn = this.widget.querySelector('.webchat-control-btn[onclick="webChat.sendMessage()"]');
    if (sendBtn) {
        sendBtn.title = this.texts.interface.sendTooltip;
    }
    
    // 8. ✅ Переключатель быстрых кнопок
    const quickToggleBtn = this.widget.querySelector('.webchat-quick-toggle-btn');
    if (quickToggleBtn) {
        const isCollapsed = this.quickButtonsCollapsed;
        quickToggleBtn.title = isCollapsed ? 
            (this.texts.quickButtons?.toggleShow || 'Показать быстрые команды') : 
            (this.texts.quickButtons?.toggleHide || 'Скрыть быстрые команды');
    }
    
    // 9. ✅ ИСПРАВЛЕНО: НЕ перезаписываем HTML индикатора печатания
   this.typingIndicator.innerHTML = `${this.texts.interface.typingIndicator}<span class="webchat-typing-dots">
    <span class="webchat-typing-dot"></span>
    <span class="webchat-typing-dot"></span>
    <span class="webchat-typing-dot"></span>
</span>`;
    
    // 10. ✅ Обновляем опции переключателя конфигураций
    this.updateConfigSelectOptions();
    
    // 11. ✅ Обновляем систему языков при смене конфигурации
    this.updateLanguageSystem();
    
    // 12. ✅ Переинициализируем обработчики файлов после обновления интерфейса
    setTimeout(() => {
        this.reinitializeFileHandlers();
    }, 100);
    // 13. ✅ Обновляем все времена при смене языка
    this.updateAllMessageTimes();
    // 14. ✅ Обновляем опции переключателя конфигураций
    this.updateConfigSelectOptions();
    
    // 15. ✅ Обновляем тексты в области preview файлов
    const filePreviewLabel = this.widget.querySelector('.webchat-file-preview-label');
    if (filePreviewLabel) {
        filePreviewLabel.textContent = (this.texts.interface && this.texts.interface.selectedFile) || 'Выбранный файл:';
    }
    
    const filePreviewCloseBtn = this.widget.querySelector('.webchat-file-preview-close');
    if (filePreviewCloseBtn) {
        filePreviewCloseBtn.title = (this.texts.interface && this.texts.interface.removeFile) || 'Убрать файл';
    }
}

// Обновление отображения контактов
    // ✅ УЛУЧШЕННОЕ: Обновление отображения контактов с полной перерисовкой
updateContactsDisplay() {
    const existingContainer = this.widget.querySelector('.webchat-contacts-container');
    
    // ✅ НОВОЕ: Всегда удаляем старые контакты перед добавлением новых
    if (existingContainer) {
        existingContainer.remove();
        this.contactsPopup = null;
        this.fileInput = null;
        this.filePreview = null;
        this.fileUploadingIndicator = null;
    }
    
    // Проверяем нужно ли показывать контакты для ТЕКУЩЕЙ конфигурации
    if (this.shouldShowContacts()) {
        const headerInfo = this.widget.querySelector('.webchat-header-info');
        const minimizeBtn = this.widget.querySelector('.webchat-minimize-btn');
        
        if (headerInfo && minimizeBtn) {
            // ✅ НОВОЕ: Генерируем контакты заново для текущей конфигурации
            const contactsHTML = this.generateContactsHTML();
            minimizeBtn.insertAdjacentHTML('beforebegin', contactsHTML);
            
            // Обновляем ссылку на popup
            this.contactsPopup = document.getElementById('webchatContactsPopup');
            
            // Настраиваем события для нового popup
            this.setupContactsEvents();
            
        }
    } else {

    }
}

   // Применение настроек внешнего вида
applyAppearanceSettings() {
    if (!this.widget || !this.config.appearance) return;

    const appearance = this.config.appearance;
    const style = this.widget.style;

    // ✅ ИСПРАВЛЕНИЕ: Проверяем - если мобильное устройство с развернутым чатом,
    // то НЕ МЕНЯЕМ позиционирование, чтобы избежать "прыжков"
    const isMobileExpanded = this.isMobileDevice() && !this.isMinimized;

    // 1. Применяем размеры (только если не свернут и не мобильное устройство)
    if (!this.isMinimized && !isMobileExpanded) {
        // ✅ ИСПРАВЛЕНИЕ: Применяем размеры напрямую без отключения transitions
        // Это предотвращает "скачки" и паузы при разворачивании чата
        style.width = appearance.dimensions.width + 'px';
        style.height = appearance.dimensions.height + 'px';
        style.maxWidth = appearance.dimensions.width + 'px';
        style.maxHeight = appearance.dimensions.height + 'px';
    }

    // 2. Позиция (только для десктопа или свернутого мобильного чата)
    if (!isMobileExpanded) {
        // Сбрасываем все позиции
        style.top = 'auto';
        style.bottom = 'auto';
        style.left = 'auto';
        style.right = 'auto';

        if (appearance.position.includes('bottom')) {
            style.bottom = (appearance.margins?.bottom || 20) + 'px';
        } else {
            style.top = (appearance.margins?.top || 20) + 'px';
        }

        if (appearance.position.includes('right')) {
            style.right = (appearance.margins?.right || 20) + 'px';
        } else {
            style.left = (appearance.margins?.left || 20) + 'px';
        }
    }

    // ✅ НОВОЕ: Устанавливаем режим работы
    this.isCompactMode = true;
}

    // Настройка обработчиков событий
    setupEventListeners() {
        // Обработка нажатий клавиш в поле ввода
        if (this.messageInput) {
    this.messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.sendMessage();
        }
    });

    // Автоизменение размера поля ввода с debouncing для производительности
    this.messageInput.addEventListener('input', this.debounce(() => {
        this.autoResizeInput();
    }, 50));
}

       // Фокус при клике на виджет (НО НЕ на переключатель!)
        this.widget.addEventListener('click', (e) => {
            // Игнорируем клики на переключателе конфигураций
            if (e.target.closest('.webchat-config-switcher')) {
                return;
            }

            // ✅ НОВОЕ: Закрываем контакты при клике в область чата
            if (!e.target.closest('.webchat-contacts-container') &&
                !e.target.closest('.webchat-contacts-popup')) {
                this.hideContacts();
            }

            // ✅ ИСПРАВЛЕНИЕ: На мобильных не автофокусируем, если клик не в поле ввода
            // Это предотвращает постоянное появление клавиатуры
            if (!this.isMinimized && this.config.behavior && this.config.behavior.autoFocus) {
                // На мобильных фокусируем только при клике непосредственно в поле ввода
                if (this.isMobileDevice()) {
                    // Проверяем, кликнули ли прямо в поле ввода
                    if (e.target === this.messageInput || e.target.closest('.webchat-input-area')) {
                        // Фокус будет установлен автоматически браузером
                        return;
                    }
                    // Если клик не в область ввода - НЕ фокусируем
                    return;
                } else {
                    // На десктопе работает как раньше
                    if (this.messageInput) {
                        this.messageInput.focus();
                    }
                }
            }
        });

        // Предотвращение закрытия при клике внутри виджета, КРОМЕ переключателя
        this.widget.addEventListener('click', (e) => {
            // Позволяем всплытие событий для переключателя конфигураций
            if (e.target.closest('.webchat-config-switcher')) {
                return;
            }
            
            e.stopPropagation();
        });

        // ✅ УЛУЧШЕННОЕ: Обработчики для переключателя конфигураций
        if (this.configSelect) {
            this.setupConfigSelectEvents();
            // ✅ НОВОЕ: Обработчики для системы контактов
            this.setupContactsEvents();
        }
        // ✅ НОВОЕ: Клик по компактному чату для разворачивания
if (this.isCompactMode) {
    this.widget.addEventListener('click', (e) => {
        // Если компактный режим и чат свернут - разворачиваем при клике
        if (this.isMinimized && this.widget.classList.contains('webchat-compact')) {
            // Игнорируем клики по кнопке сворачивания (если она есть)
            if (!e.target.closest('.webchat-minimize-btn')) {
                this.toggleChat();
                e.stopPropagation();
            }
        }
    });
    // ✅ НОВОЕ: Обработчики файлов
        this.setupFileHandlers();
 }
}
// ✅ НОВЫЙ МЕТОД: Применение кастомных настроек
applyCustomAppearance() {
    if (!this.widget || !this.config.appearance) return;
    
    const appearance = this.config.appearance;
    
    // ✅ НОВОЕ: Применяем размеры виджета
    this.applyWidgetDimensions();
    
    // Применяем кастомные шрифты
    if (appearance.fonts) {
        this.applyCustomFonts(appearance.fonts);
    }
    
    // Применяем кастомные цвета
    if (appearance.colors) {
        this.applyCustomColors(appearance.colors);
    }
}

    // Применение кастомных шрифтов
    applyCustomFonts(fonts) {
        const isMobile = this.isMobileDevice();
        const fontConfig = isMobile ? fonts.mobile : fonts.desktop;
        
        if (!fontConfig) return;
        
        // Применяем к сообщениям
        if (fontConfig.messageSize) {
            const style = document.createElement('style');
            style.textContent = `
                .webchat-widget .webchat-message-content {
                    font-size: ${fontConfig.messageSize} !important;
                    font-family: ${fontConfig.family} !important;
                }
            `;
            document.head.appendChild(style);
        }
        
        // Применяем к заголовкам
        if (fontConfig.headerSize) {
            const headerTitle = this.widget.querySelector('.webchat-header-title');
            const headerSubtitle = this.widget.querySelector('.webchat-header-subtitle');
            
            if (headerTitle) {
                headerTitle.style.fontSize = fontConfig.headerSize;
                headerTitle.style.fontFamily = fontConfig.family;
            }
            if (headerSubtitle) {
                headerSubtitle.style.fontSize = `calc(${fontConfig.headerSize} * 0.75)`;
                headerSubtitle.style.fontFamily = fontConfig.family;
            }
        }
        
        // Применяем к кнопкам
        if (fontConfig.quickButtonSize) {
            const style = document.createElement('style');
            style.textContent = `
                .webchat-widget .webchat-quick-btn {
                    font-size: ${fontConfig.quickButtonSize} !important;
                    font-family: ${fontConfig.family} !important;
                }
            `;
            document.head.appendChild(style);
        }
    }

// ✅ НОВАЯ ФУНКЦИЯ: Добавление стилей для кликабельных ссылок
addLinkStyles() {
    // Удаляем старые стили если есть
    const oldLinkStyle = document.getElementById('webchat-link-styles');
    if (oldLinkStyle) {
        oldLinkStyle.remove();
    }

    const linkStyle = document.createElement('style');
    linkStyle.id = 'webchat-link-styles';
    linkStyle.textContent = `
        /* Максимально специфичные стили для ссылок - полное наследование цвета текста */
        .webchat-widget .webchat-message-content a,
        .webchat-widget .webchat-message-content a:link,
        .webchat-widget .webchat-message-content a:visited,
        .webchat-widget .webchat-message-content a:hover,
        .webchat-widget .webchat-message-content a:active,
        .webchat-widget .webchat-message-content a:focus {
            color: inherit !important;
            text-decoration: none !important;
            background: none !important;
            border: none !important;
            cursor: pointer !important;
            font-weight: inherit !important;
            font-style: inherit !important;
        }
    `;
    document.head.appendChild(linkStyle);
    this.log('debug', '🔗 Стили для ссылок применены');
}

   // Применение кастомных цветов
applyCustomColors(colors) {
    // Цвета шапки
    if (colors.header) {
        const header = this.widget.querySelector('.webchat-header');
        if (header) {
            if (colors.header.background) {
                header.style.background = colors.header.background;
            }
            if (colors.header.textColor) {
                header.style.color = colors.header.textColor;
            }
        }
    }
    
    // Цвета кнопок
    if (colors.buttons) {
        const style = document.createElement('style');
        style.id = 'webchat-button-colors'; // Добавляем ID для управления
        style.setAttribute('data-webchat-dynamic', 'true'); // ✅ НОВОЕ: Маркер для очистки
        style.textContent = `
            /* Применяем цвета только к видимым кнопкам */
            .webchat-widget .webchat-control-btn:not([style*="display: none"]),
            .webchat-widget .webchat-file-btn:not([style*="display: none"]) {
                background: ${colors.buttons.background} !important;
                color: ${colors.buttons.textColor} !important;
            }
            .webchat-widget .webchat-control-btn:not([style*="display: none"]):hover,
            .webchat-widget .webchat-file-btn:not([style*="display: none"]):hover {
                background: ${colors.buttons.hoverBackground} !important;
            }
        `;
        
        // Удаляем старые стили если есть
        const oldStyle = document.getElementById('webchat-button-colors');
        if (oldStyle) {
            oldStyle.remove();
        }
        
        document.head.appendChild(style);
    }
    
    // Цвета сообщений пользователя
    if (colors.userMessage) {
        const style = document.createElement('style');
        style.setAttribute('data-webchat-dynamic', 'true'); // ✅ НОВОЕ: Маркер для очистки
        style.textContent = `
            .webchat-widget .webchat-message.webchat-user .webchat-message-content {
                background: ${colors.userMessage.background} !important;
                color: ${colors.userMessage.textColor} !important;
                border-color: ${colors.userMessage.background} !important;
            }
            .webchat-widget .webchat-message.webchat-user .webchat-message-content:after {
                border-left-color: ${colors.userMessage.background} !important;
            }
        `;
        document.head.appendChild(style);
    }
}

// ✅ НОВОЕ: Добавление стилей для виджетов свернутого чата
addWidgetStyles(widgetType, settings) {
    const { animationSpeed = 2, primaryColor, size = 70, position = 'bottom-right', margins = {} } = settings || {};

    // Удаляем старые стили виджета если есть
    const oldWidgetStyle = document.getElementById('webchat-widget-styles');
    if (oldWidgetStyle) {
        oldWidgetStyle.remove();
    }

    const style = document.createElement('style');
    style.id = 'webchat-widget-styles';
    style.setAttribute('data-webchat-dynamic', 'true');

    // ✅ НОВОЕ: Применяем позиционирование на основе настроек
    let positionStyles = '';
    if (position.includes('bottom')) {
        positionStyles += `bottom: ${margins.bottom || 20}px;`;
    } else {
        positionStyles += `top: ${margins.top || 20}px;`;
    }

    if (position.includes('right')) {
        positionStyles += `right: ${margins.right || 20}px;`;
    } else {
        positionStyles += `left: ${margins.left || 20}px;`;
    }

    // Базовые стили для всех виджетов
    let widgetStyles = `
        .webchat-floating-widget {
            position: fixed;
            ${positionStyles}
            z-index: 999999;
            cursor: pointer;
            transition: transform 0.3s ease;
        }

        .webchat-floating-widget:hover {
            transform: scale(1.05);
        }

        .webchat-widget-container {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            width: ${size}px;
            height: ${size}px;
        }

        .webchat-widget-icon {
            font-size: ${Math.floor(size * 0.45)}px;
            z-index: 2;
            position: relative;
        }
    `;

    // Добавляем специфичные стили для каждого виджета
    switch(widgetType) {
        case 'Neural Network Pulse':
            widgetStyles += `
                .webchat-widget-neural {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#667eea'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#764ba2'} 100%);
                    border-radius: 50%;
                    position: relative;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4);
                }

                .webchat-widget-neural::before,
                .webchat-widget-neural::after {
                    content: '';
                    position: absolute;
                    width: 100%;
                    height: 100%;
                    border-radius: 50%;
                    border: 2px solid ${primaryColor || '#667eea'};
                    opacity: 0;
                    animation: neural-pulse ${animationSpeed}s infinite;
                }

                .webchat-widget-neural::after {
                    animation-delay: ${animationSpeed / 2}s;
                }

                @keyframes neural-pulse {
                    0% {
                        transform: scale(1);
                        opacity: 1;
                    }
                    100% {
                        transform: scale(1.8);
                        opacity: 0;
                    }
                }
            `;
            break;

        case 'Morphing Blob':
            widgetStyles += `
                .webchat-widget-blob {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#f093fb'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#f5576c'} 100%);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    animation: morph ${animationSpeed * 4}s infinite;
                    box-shadow: 0 5px 25px rgba(245, 87, 108, 0.5);
                }

                @keyframes morph {
                    0%, 100% {
                        border-radius: 60% 40% 30% 70% / 60% 30% 70% 40%;
                    }
                    25% {
                        border-radius: 30% 60% 70% 40% / 50% 60% 30% 60%;
                    }
                    50% {
                        border-radius: 50% 60% 30% 60% / 30% 60% 70% 40%;
                    }
                    75% {
                        border-radius: 60% 40% 60% 40% / 70% 30% 50% 60%;
                    }
                }
            `;
            break;

        case 'Minimal Ring':
            widgetStyles += `
                .webchat-widget-ring {
                    width: ${size}px;
                    height: ${size}px;
                    border: 4px solid ${primaryColor || '#667eea'};
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: white;
                    transition: all 0.3s ease;
                }

                .webchat-widget-ring:hover {
                    background: ${primaryColor || '#667eea'};
                    transform: scale(1.1);
                }

                .webchat-widget-ring:hover .webchat-widget-icon {
                    color: white !important;
                }

                .webchat-widget-ring .webchat-widget-icon {
                    color: ${primaryColor || '#667eea'};
                    transition: all 0.3s ease;
                }
            `;
            break;

        case 'AI Robot Assistant':
            widgetStyles += `
                .webchat-widget-robot {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#6366f1'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#8b5cf6'} 100%);
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    animation: robot-bounce ${animationSpeed * 0.75}s infinite ease-in-out;
                    box-shadow: 0 8px 30px rgba(99, 102, 241, 0.6);
                }

                @keyframes robot-bounce {
                    0%, 100% {
                        transform: translateY(0) scale(1);
                    }
                    50% {
                        transform: translateY(-8px) scale(1.05);
                    }
                }

                .webchat-widget-robot .pulse-ring {
                    position: absolute;
                    width: 100%;
                    height: 100%;
                    border-radius: 50%;
                    border: 3px solid ${primaryColor || '#6366f1'};
                    animation: ai-pulse ${animationSpeed}s infinite;
                    opacity: 0;
                }

                @keyframes ai-pulse {
                    0% {
                        transform: scale(1);
                        opacity: 1;
                    }
                    100% {
                        transform: scale(1.6);
                        opacity: 0;
                    }
                }
            `;
            break;

        case 'Financial Advisor':
            widgetStyles += `
                .webchat-widget-finance {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#10b981'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#059669'} 100%);
                    border-radius: 20px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    animation: money-flip ${animationSpeed * 1.5}s infinite;
                    box-shadow: 0 8px 30px rgba(16, 185, 129, 0.6);
                }

                @keyframes money-flip {
                    0%, 100% {
                        transform: rotateY(0deg);
                    }
                    50% {
                        transform: rotateY(180deg);
                    }
                }

                .webchat-widget-finance::before {
                    content: '💵';
                    position: absolute;
                    font-size: ${Math.floor(size * 0.25)}px;
                    top: -${Math.floor(size * 0.125)}px;
                    right: -${Math.floor(size * 0.125)}px;
                    animation: float-coin ${animationSpeed}s infinite ease-in-out;
                }

                @keyframes float-coin {
                    0%, 100% {
                        transform: translateY(0px) rotate(0deg);
                    }
                    50% {
                        transform: translateY(-10px) rotate(180deg);
                    }
                }
            `;
            break;

        case 'Medical Support':
            widgetStyles += `
                .webchat-widget-medical {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#ef4444'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#dc2626'} 100%);
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    animation: heartbeat ${animationSpeed * 0.75}s infinite;
                    box-shadow: 0 8px 30px rgba(239, 68, 68, 0.6);
                }

                @keyframes heartbeat {
                    0%, 100% {
                        transform: scale(1);
                    }
                    10% {
                        transform: scale(1.1);
                    }
                    20% {
                        transform: scale(1);
                    }
                    30% {
                        transform: scale(1.1);
                    }
                    40% {
                        transform: scale(1);
                    }
                }

                .webchat-widget-medical::before,
                .webchat-widget-medical::after {
                    content: '+';
                    position: absolute;
                    color: white;
                    font-size: ${Math.floor(size * 0.375)}px;
                    font-weight: bold;
                    opacity: 0;
                    animation: medical-cross ${animationSpeed}s infinite;
                }

                .webchat-widget-medical::after {
                    animation-delay: ${animationSpeed / 2}s;
                }

                @keyframes medical-cross {
                    0% {
                        transform: scale(0.5) rotate(0deg);
                        opacity: 0;
                    }
                    50% {
                        opacity: 0.5;
                    }
                    100% {
                        transform: scale(2) rotate(90deg);
                        opacity: 0;
                    }
                }
            `;
            break;

        case 'Education & Learning':
            widgetStyles += `
                .webchat-widget-education {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#f59e0b'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#d97706'} 100%);
                    border-radius: 15px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    animation: book-flip ${animationSpeed * 2}s infinite ease-in-out;
                    box-shadow: 0 8px 30px rgba(245, 158, 11, 0.6);
                    transform-style: preserve-3d;
                }

                @keyframes book-flip {
                    0%, 100% {
                        transform: rotateY(0deg);
                    }
                    50% {
                        transform: rotateY(180deg);
                    }
                }

                .webchat-widget-education::before {
                    content: '✨';
                    position: absolute;
                    font-size: ${Math.floor(size * 0.25)}px;
                    top: -${Math.floor(size * 0.1)}px;
                    right: -${Math.floor(size * 0.1)}px;
                    animation: sparkle-rotate ${animationSpeed * 1.5}s infinite linear;
                }

                @keyframes sparkle-rotate {
                    0% {
                        transform: rotate(0deg) scale(1);
                        opacity: 1;
                    }
                    50% {
                        transform: rotate(180deg) scale(1.3);
                        opacity: 0.7;
                    }
                    100% {
                        transform: rotate(360deg) scale(1);
                        opacity: 1;
                    }
                }
            `;
            break;

        case 'Expert Consulting':
            widgetStyles += `
                .webchat-widget-expert {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#3b82f6'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#1d4ed8'} 100%);
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    box-shadow: 0 8px 30px rgba(59, 130, 246, 0.6);
                    animation: professional-pulse ${animationSpeed * 1.5}s infinite;
                }

                @keyframes professional-pulse {
                    0%, 100% {
                        transform: scale(1);
                        box-shadow: 0 8px 30px rgba(59, 130, 246, 0.6);
                    }
                    50% {
                        transform: scale(1.08);
                        box-shadow: 0 12px 40px rgba(59, 130, 246, 0.8);
                    }
                }

                .webchat-widget-expert::before {
                    content: '💼';
                    position: absolute;
                    font-size: ${Math.floor(size * 0.3)}px;
                    bottom: -${Math.floor(size * 0.0625)}px;
                    right: -${Math.floor(size * 0.0625)}px;
                    animation: briefcase-swing ${animationSpeed}s infinite ease-in-out;
                }

                @keyframes briefcase-swing {
                    0%, 100% {
                        transform: rotate(-10deg);
                    }
                    50% {
                        transform: rotate(10deg);
                    }
                }
            `;
            break;

        case '24/7 Online Support':
            widgetStyles += `
                .webchat-widget-support {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#8b5cf6'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#7c3aed'} 100%);
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    animation: support-glow ${animationSpeed}s infinite alternate;
                    box-shadow: 0 8px 30px rgba(139, 92, 246, 0.6);
                }

                @keyframes support-glow {
                    0% {
                        box-shadow: 0 8px 30px rgba(139, 92, 246, 0.6);
                    }
                    100% {
                        box-shadow: 0 12px 45px rgba(139, 92, 246, 0.9), 0 0 60px rgba(139, 92, 246, 0.4);
                    }
                }

                .notification-badge {
                    position: absolute;
                    top: -8px;
                    right: -8px;
                    background: #ef4444;
                    color: white;
                    font-size: ${Math.floor(size * 0.14)}px;
                    font-weight: bold;
                    padding: 3px 6px;
                    border-radius: 10px;
                    animation: badge-bounce 1s infinite;
                    box-shadow: 0 2px 8px rgba(239, 68, 68, 0.5);
                }

                @keyframes badge-bounce {
                    0%, 100% {
                        transform: scale(1);
                    }
                    50% {
                        transform: scale(1.2);
                    }
                }
            `;
            break;

        case 'Shopping Assistant':
            widgetStyles += `
                .webchat-widget-shopping {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#ec4899'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#db2777'} 100%);
                    border-radius: 20px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    animation: shopping-shake ${animationSpeed * 1.5}s infinite;
                    box-shadow: 0 8px 30px rgba(236, 72, 153, 0.6);
                }

                @keyframes shopping-shake {
                    0%, 100% {
                        transform: rotate(0deg);
                    }
                    25% {
                        transform: rotate(-5deg);
                    }
                    75% {
                        transform: rotate(5deg);
                    }
                }

                .webchat-widget-shopping::before {
                    content: '🏷️';
                    position: absolute;
                    font-size: ${Math.floor(size * 0.25)}px;
                    top: -${Math.floor(size * 0.1)}px;
                    left: -${Math.floor(size * 0.1)}px;
                    animation: tag-spin ${animationSpeed * 2}s infinite linear;
                }

                @keyframes tag-spin {
                    0% {
                        transform: rotate(0deg);
                    }
                    100% {
                        transform: rotate(360deg);
                    }
                }
            `;
            break;

        case 'Tech Support':
            widgetStyles += `
                .webchat-widget-tech {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#6b7280'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#4b5563'} 100%);
                    border-radius: 15px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    animation: tech-rotate ${animationSpeed * 2}s infinite linear;
                    box-shadow: 0 8px 30px rgba(107, 114, 128, 0.6);
                }

                @keyframes tech-rotate {
                    0% {
                        transform: rotate(0deg);
                    }
                    100% {
                        transform: rotate(360deg);
                    }
                }

                .webchat-widget-tech .webchat-widget-icon {
                    animation: tech-counter-rotate ${animationSpeed * 2}s infinite linear;
                }

                @keyframes tech-counter-rotate {
                    0% {
                        transform: rotate(0deg);
                    }
                    100% {
                        transform: rotate(-360deg);
                    }
                }

                .webchat-widget-tech::before,
                .webchat-widget-tech::after {
                    content: '⚙️';
                    position: absolute;
                    font-size: ${Math.floor(size * 0.2)}px;
                    opacity: 0.4;
                }

                .webchat-widget-tech::before {
                    top: ${Math.floor(size * 0.0625)}px;
                    left: ${Math.floor(size * 0.0625)}px;
                    animation: gear-spin-1 ${animationSpeed * 1.5}s infinite linear;
                }

                .webchat-widget-tech::after {
                    bottom: ${Math.floor(size * 0.0625)}px;
                    right: ${Math.floor(size * 0.0625)}px;
                    animation: gear-spin-2 ${animationSpeed * 1.5}s infinite linear reverse;
                }

                @keyframes gear-spin-1 {
                    0% {
                        transform: rotate(0deg);
                    }
                    100% {
                        transform: rotate(360deg);
                    }
                }

                @keyframes gear-spin-2 {
                    0% {
                        transform: rotate(0deg);
                    }
                    100% {
                        transform: rotate(-360deg);
                    }
                }
            `;
            break;

        case 'Travel Agent':
            widgetStyles += `
                .webchat-widget-travel {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#06b6d4'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#0891b2'} 100%);
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    animation: plane-fly ${animationSpeed * 2.5}s infinite ease-in-out;
                    box-shadow: 0 8px 30px rgba(6, 182, 212, 0.6);
                }

                @keyframes plane-fly {
                    0%, 100% {
                        transform: translateX(0) translateY(0);
                    }
                    25% {
                        transform: translateX(10px) translateY(-10px);
                    }
                    50% {
                        transform: translateX(0) translateY(-5px);
                    }
                    75% {
                        transform: translateX(-10px) translateY(-10px);
                    }
                }

                .webchat-widget-travel::before {
                    content: '🌍';
                    position: absolute;
                    font-size: ${Math.floor(size * 0.25)}px;
                    bottom: -${Math.floor(size * 0.1)}px;
                    left: -${Math.floor(size * 0.1)}px;
                    animation: globe-spin ${animationSpeed * 4}s infinite linear;
                }

                @keyframes globe-spin {
                    0% {
                        transform: rotate(0deg);
                    }
                    100% {
                        transform: rotate(360deg);
                    }
                }
            `;
            break;

        case 'Legal Advisor':
            widgetStyles += `
                .webchat-widget-legal {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#713f12'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#92400e'} 100%);
                    border-radius: 15px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    animation: justice-balance ${animationSpeed * 1.5}s infinite ease-in-out;
                    box-shadow: 0 8px 30px rgba(113, 63, 18, 0.6);
                }

                @keyframes justice-balance {
                    0%, 100% {
                        transform: rotate(0deg);
                    }
                    25% {
                        transform: rotate(-3deg);
                    }
                    75% {
                        transform: rotate(3deg);
                    }
                }

                .webchat-widget-legal::before {
                    content: '📋';
                    position: absolute;
                    font-size: ${Math.floor(size * 0.25)}px;
                    top: -${Math.floor(size * 0.1)}px;
                    right: -${Math.floor(size * 0.1)}px;
                    animation: document-flutter ${animationSpeed}s infinite ease-in-out;
                }

                @keyframes document-flutter {
                    0%, 100% {
                        transform: translateY(0px) rotate(0deg);
                    }
                    50% {
                        transform: translateY(-5px) rotate(5deg);
                    }
                }
            `;
            break;

        case 'Crypto Trading Bot':
            widgetStyles += `
                .webchat-widget-crypto {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#f7931a'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#ff8c00'} 100%);
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    animation: crypto-pulse ${animationSpeed}s infinite;
                    box-shadow: 0 8px 30px rgba(247, 147, 26, 0.6);
                }

                @keyframes crypto-pulse {
                    0%, 100% {
                        transform: scale(1) rotate(0deg);
                        box-shadow: 0 8px 30px rgba(247, 147, 26, 0.6);
                    }
                    50% {
                        transform: scale(1.1) rotate(180deg);
                        box-shadow: 0 12px 40px rgba(247, 147, 26, 0.9);
                    }
                }

                .webchat-widget-crypto::before,
                .webchat-widget-crypto::after {
                    content: '📈';
                    position: absolute;
                    font-size: ${Math.floor(size * 0.225)}px;
                    animation: chart-rise ${animationSpeed * 1.5}s infinite;
                }

                .webchat-widget-crypto::before {
                    top: -${Math.floor(size * 0.125)}px;
                    right: -${Math.floor(size * 0.0625)}px;
                }

                .webchat-widget-crypto::after {
                    content: '💹';
                    bottom: -${Math.floor(size * 0.125)}px;
                    left: -${Math.floor(size * 0.0625)}px;
                    animation-delay: ${animationSpeed * 0.75}s;
                }

                @keyframes chart-rise {
                    0%, 100% {
                        transform: translateY(0) scale(0.8);
                        opacity: 0;
                    }
                    50% {
                        transform: translateY(-20px) scale(1);
                        opacity: 1;
                    }
                }
            `;
            break;

        case 'Food Delivery':
            widgetStyles += `
                .webchat-widget-food {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#ff6b6b'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#ee5a6f'} 100%);
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    animation: food-steam ${animationSpeed * 1.5}s infinite ease-in-out;
                    box-shadow: 0 8px 30px rgba(255, 107, 107, 0.6);
                }

                @keyframes food-steam {
                    0%, 100% {
                        transform: translateY(0);
                    }
                    50% {
                        transform: translateY(-5px);
                    }
                }

                .webchat-widget-food::before,
                .webchat-widget-food::after {
                    content: '🍔';
                    position: absolute;
                    font-size: ${Math.floor(size * 0.2)}px;
                    opacity: 0;
                    animation: steam-rise ${animationSpeed}s infinite;
                }

                .webchat-widget-food::before {
                    top: -${Math.floor(size * 0.25)}px;
                    animation-delay: 0s;
                }

                .webchat-widget-food::after {
                    top: -${Math.floor(size * 0.25)}px;
                    animation-delay: ${animationSpeed / 2}s;
                }

                @keyframes steam-rise {
                    0% {
                        transform: translateY(20px);
                        opacity: 0;
                    }
                    50% {
                        opacity: 0.7;
                    }
                    100% {
                        transform: translateY(-10px);
                        opacity: 0;
                    }
                }
            `;
            break;

        case 'Fitness Coach':
            widgetStyles += `
                .webchat-widget-fitness {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#ff6348'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#e74c3c'} 100%);
                    border-radius: 20px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    animation: muscle-flex ${animationSpeed * 0.75}s infinite;
                    box-shadow: 0 8px 30px rgba(255, 99, 72, 0.6);
                }

                @keyframes muscle-flex {
                    0%, 100% {
                        transform: scale(1);
                    }
                    25% {
                        transform: scale(1.1) rotate(-5deg);
                    }
                    75% {
                        transform: scale(1.1) rotate(5deg);
                    }
                }

                .webchat-widget-fitness::before {
                    content: '🔥';
                    position: absolute;
                    font-size: ${Math.floor(size * 0.25)}px;
                    top: -${Math.floor(size * 0.125)}px;
                    right: -${Math.floor(size * 0.125)}px;
                    animation: fire-flicker 0.5s infinite alternate;
                }

                @keyframes fire-flicker {
                    0% {
                        transform: scale(1) translateY(0);
                    }
                    100% {
                        transform: scale(1.2) translateY(-3px);
                    }
                }
            `;
            break;

        case 'Real Estate Agent':
            widgetStyles += `
                .webchat-widget-realestate {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#4ecdc4'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#44a08d'} 100%);
                    border-radius: 15px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    animation: house-build ${animationSpeed * 2}s infinite ease-in-out;
                    box-shadow: 0 8px 30px rgba(78, 205, 196, 0.6);
                }

                @keyframes house-build {
                    0%, 100% {
                        transform: translateY(0) scale(1);
                    }
                    50% {
                        transform: translateY(-10px) scale(1.05);
                    }
                }

                .webchat-widget-realestate::before {
                    content: '🔑';
                    position: absolute;
                    font-size: ${Math.floor(size * 0.25)}px;
                    bottom: -${Math.floor(size * 0.125)}px;
                    right: -${Math.floor(size * 0.125)}px;
                    animation: key-swing ${animationSpeed}s infinite ease-in-out;
                }

                @keyframes key-swing {
                    0%, 100% {
                        transform: rotate(0deg);
                    }
                    50% {
                        transform: rotate(20deg);
                    }
                }
            `;
            break;

        case 'Weather Assistant':
            widgetStyles += `
                .webchat-widget-weather {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#56ccf2'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#2f80ed'} 100%);
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    animation: cloud-float ${animationSpeed * 2.5}s infinite ease-in-out;
                    box-shadow: 0 8px 30px rgba(86, 204, 242, 0.6);
                }

                @keyframes cloud-float {
                    0%, 100% {
                        transform: translateX(0);
                    }
                    50% {
                        transform: translateX(15px);
                    }
                }

                .webchat-widget-weather::before,
                .webchat-widget-weather::after {
                    content: '☁️';
                    position: absolute;
                    font-size: ${Math.floor(size * 0.225)}px;
                    animation: cloud-drift ${animationSpeed * 4}s infinite;
                }

                .webchat-widget-weather::before {
                    top: ${Math.floor(size * 0.0625)}px;
                    left: -${Math.floor(size * 0.1875)}px;
                    animation-delay: 0s;
                }

                .webchat-widget-weather::after {
                    bottom: ${Math.floor(size * 0.0625)}px;
                    right: -${Math.floor(size * 0.1875)}px;
                    animation-delay: ${animationSpeed * 2}s;
                }

                @keyframes cloud-drift {
                    0%, 100% {
                        transform: translateX(0);
                        opacity: 0.5;
                    }
                    50% {
                        transform: translateX(10px);
                        opacity: 1;
                    }
                }
            `;
            break;

        case 'Car Service Bot':
            widgetStyles += `
                .webchat-widget-car {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#30cfd0'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#330867'} 100%);
                    border-radius: 20px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    animation: car-drive ${animationSpeed * 1.5}s infinite ease-in-out;
                    box-shadow: 0 8px 30px rgba(48, 207, 208, 0.6);
                }

                @keyframes car-drive {
                    0%, 100% {
                        transform: translateX(0);
                    }
                    50% {
                        transform: translateX(10px);
                    }
                }

                .webchat-widget-car::before,
                .webchat-widget-car::after {
                    content: '💨';
                    position: absolute;
                    font-size: ${Math.floor(size * 0.2)}px;
                    left: -${Math.floor(size * 0.25)}px;
                    opacity: 0;
                    animation: exhaust 1s infinite;
                }

                .webchat-widget-car::before {
                    top: ${Math.floor(size * 0.25)}px;
                    animation-delay: 0s;
                }

                .webchat-widget-car::after {
                    top: ${Math.floor(size * 0.375)}px;
                    animation-delay: 0.5s;
                }

                @keyframes exhaust {
                    0% {
                        transform: translateX(0);
                        opacity: 0.8;
                    }
                    100% {
                        transform: translateX(-20px);
                        opacity: 0;
                    }
                }
            `;
            break;

        case 'Photography Studio':
            widgetStyles += `
                .webchat-widget-photo {
                    width: ${size}px;
                    height: ${size}px;
                    background: linear-gradient(135deg, ${primaryColor || '#ffecd2'} 0%, ${primaryColor ? adjustColor(primaryColor, -20) : '#fcb69f'} 100%);
                    border-radius: 15px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    position: relative;
                    animation: camera-focus ${animationSpeed}s infinite ease-in-out;
                    box-shadow: 0 8px 30px rgba(252, 182, 159, 0.6);
                }

                @keyframes camera-focus {
                    0%, 100% {
                        transform: scale(1);
                        box-shadow: 0 8px 30px rgba(252, 182, 159, 0.6);
                    }
                    50% {
                        transform: scale(1.05);
                        box-shadow: 0 12px 40px rgba(252, 182, 159, 0.9);
                    }
                }

                .webchat-widget-photo::before {
                    content: '✨';
                    position: absolute;
                    font-size: ${Math.floor(size * 0.25)}px;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    animation: flash ${animationSpeed * 1.5}s infinite;
                    opacity: 0;
                }

                @keyframes flash {
                    0%, 90%, 100% {
                        opacity: 0;
                        transform: translate(-50%, -50%) scale(0.5);
                    }
                    95% {
                        opacity: 1;
                        transform: translate(-50%, -50%) scale(2);
                    }
                }
            `;
            break;
    }

    style.textContent = widgetStyles;
    document.head.appendChild(style);
}

// ✅ НОВОЕ: Получение HTML для виджета
getWidgetHTML(widgetType, icon) {
    const widgetMap = {
        'Neural Network Pulse': 'neural',
        'Morphing Blob': 'blob',
        'Minimal Ring': 'ring',
        'AI Robot Assistant': 'robot',
        'Financial Advisor': 'finance',
        'Medical Support': 'medical',
        'Education & Learning': 'education',
        'Expert Consulting': 'expert',
        '24/7 Online Support': 'support',
        'Shopping Assistant': 'shopping',
        'Tech Support': 'tech',
        'Travel Agent': 'travel',
        'Legal Advisor': 'legal',
        'Crypto Trading Bot': 'crypto',
        'Food Delivery': 'food',
        'Fitness Coach': 'fitness',
        'Real Estate Agent': 'realestate',
        'Weather Assistant': 'weather',
        'Car Service Bot': 'car',
        'Photography Studio': 'photo'
    };

    const widgetClass = widgetMap[widgetType] || 'neural';
    let widgetHTML = `<div class="webchat-widget-${widgetClass}">`;

    // Для виджетов с пульсирующим кольцом
    if (widgetType === 'AI Robot Assistant') {
        widgetHTML += '<div class="pulse-ring"></div>';
    }

    // Для виджетов с бейджем
    if (widgetType === '24/7 Online Support') {
        widgetHTML += '<div class="notification-badge">24/7</div>';
    }

    // Добавляем иконку
    if (widgetType === 'Neural Network Pulse' || widgetType === 'Morphing Blob' || widgetType === 'Minimal Ring') {
        // SVG иконка для базовых виджетов
        widgetHTML += `
            <svg class="webchat-widget-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 32px; height: 32px;">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="${widgetType === 'Minimal Ring' ? 'currentColor' : 'white'}" stroke-width="2" stroke-linecap="round"/>
            </svg>
        `;
    } else {
        // Emoji иконка для остальных виджетов
        widgetHTML += `<div class="webchat-widget-icon">${icon}</div>`;
    }

    widgetHTML += '</div>';

    return widgetHTML;
}

// ✅ НОВОЕ: Создание плавающего виджета
createFloatingWidget() {
    // ✅ ИСПРАВЛЕНИЕ: Не создаем виджет в popout окне
    const isInPopout = window.opener && window.opener !== window;
    if (isInPopout) {
        return; // Выходим если мы в popout окне
    }

    // Удаляем старый виджет если есть
    const oldWidget = document.getElementById('webchatFloatingWidget');
    if (oldWidget) {
        oldWidget.remove();
    }

    const appearance = this.config.appearance || {};
    const widgetSettings = appearance.widget || {};
    const positionSettings = appearance.compactMinimizedPosition || {};

    // Настройки по умолчанию
    const widgetType = widgetSettings.type || 'Neural Network Pulse';
    const animationSpeed = widgetSettings.animationSpeed || 2;
    const primaryColor = widgetSettings.primaryColor || '#667eea';
    const icon = widgetSettings.icon || '💬';
    const size = widgetSettings.size || 70;

    // ✅ НОВОЕ: Получаем настройки позиционирования из widget (базовая конфигурация) или compactMinimizedPosition (индивидуальные конфигурации)
    const position = widgetSettings.position || positionSettings.position || 'bottom-right';
    const margins = widgetSettings.margins || positionSettings.margins || { top: 20, right: 20, bottom: 20, left: 20 };

    // Добавляем стили с позиционированием
    this.addWidgetStyles(widgetType, { animationSpeed, primaryColor, size, position, margins });

    // Создаем элемент виджета
    const floatingWidget = document.createElement('div');
    floatingWidget.id = 'webchatFloatingWidget';
    floatingWidget.className = 'webchat-floating-widget';
    floatingWidget.setAttribute('role', 'button');
    floatingWidget.setAttribute('aria-label', 'Open chat');
    floatingWidget.setAttribute('tabindex', '0');

    floatingWidget.innerHTML = `
        <div class="webchat-widget-container">
            ${this.getWidgetHTML(widgetType, icon)}
        </div>
    `;

    // Добавляем обработчик клика
    floatingWidget.addEventListener('click', () => {
        this.toggleChat();
    });

    // Добавляем поддержку клавиатуры
    floatingWidget.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.toggleChat();
        }
    });

    document.body.appendChild(floatingWidget);
    this.floatingWidget = floatingWidget;
}

// ✅ НОВОЕ: Управление видимостью плавающего виджета
updateFloatingWidgetVisibility() {
    if (!this.floatingWidget) return;

    if (this.isMinimized) {
        this.floatingWidget.style.display = 'block';
    } else {
        this.floatingWidget.style.display = 'none';
    }
}

// Настройка событий для контактов
    setupContactsEvents() {
        // Закрытие popup при клике вне их
        document.addEventListener('click', (e) => {
            const contactsContainer = e.target.closest('.webchat-contacts-container');
            const contactsBtn = e.target.closest('.webchat-contacts-btn');
            const contactsPopup = e.target.closest('.webchat-contacts-popup');
            
            // ✅ НОВОЕ: Проверяем клики по выпадающему меню языков
            const languageDropdown = e.target.closest('.webchat-language-dropdown');
            const languageToggle = e.target.closest('.webchat-language-toggle-btn');
            
            // Закрываем если клик НЕ по элементам
            if (!contactsContainer && !contactsBtn && !contactsPopup && 
                !languageDropdown && !languageToggle) {
                this.hideAllPopups();
            }
        });

        // Предотвращение закрытия при клике внутри popup
        if (this.contactsPopup) {
            this.contactsPopup.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }
    }

    // Настройка событий для переключателя конфигураций
    setupConfigSelectEvents() {
        if (!this.configSelect) return;
        
        this.configSelect.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        this.configSelect.addEventListener('change', (e) => {
            e.stopPropagation();
            const selectedConfig = e.target.value;
            this.switchConfig(selectedConfig);
        });

        this.configSelect.addEventListener('focus', (e) => {
            e.stopPropagation();
        });

        this.configSelect.addEventListener('blur', (e) => {
            e.stopPropagation();
        });
    }

    // ==============================================
    // УПРАВЛЕНИЕ ЧАТОМ
    // ==============================================

    // Переключение свернутого/развернутого состояния
toggleChat() {
    // ✅ ИСПРАВЛЕНИЕ: Блокируем сворачивание в popout окне
    const isInPopout = window.opener && window.opener !== window;
    if (isInPopout) {
        this.log('debug', '⚠️ Сворачивание отключено в popout окне');
        return; // Не позволяем сворачивать чат в отдельном окне
    }

    const wasMinimized = this.isMinimized;
    this.isMinimized = !this.isMinimized;

    // ✅ СПЕЦИАЛЬНАЯ ЛОГИКА ДЛЯ МОБИЛЬНЫХ УСТРОЙСТВ
    if (this.isMobileDevice()) {
        this.animateMobileToggle(wasMinimized);
    } else {
        // ✅ НОВОЕ: Полностью скрываем/показываем основной виджет
        if (this.isMinimized) {
            // Скрываем основной виджет чата
            this.widget.style.display = 'none';
        } else {
            // Показываем основной виджет чата
            this.widget.style.display = 'flex';
            this.widget.classList.remove('webchat-minimized');

            // Очищаем инлайн-стили
            this.widget.style.width = '';
            this.widget.style.height = '';
            this.widget.style.maxWidth = '';
            this.widget.style.minHeight = '';
            this.widget.style.top = '';
            this.widget.style.bottom = '';
            this.widget.style.left = '';
            this.widget.style.right = '';

            // ✅ Очищаем стили header при разворачивании
            const header = this.widget.querySelector('.webchat-header');
            if (header) {
                header.style.removeProperty('min-height');
                header.style.removeProperty('max-height');
                header.style.removeProperty('height');
                header.style.removeProperty('overflow');
            }

            this.applyAppearanceSettings();
        }
    }
    
    // Обновляем кнопку
    const btn = this.minimizeBtn;
    if (btn) {
        btn.textContent = this.isMinimized ? '+' : '−';
        btn.title = this.isMinimized ? this.texts.interface.expand : this.texts.interface.minimize;
        // ARIA атрибуты для accessibility
        btn.setAttribute('aria-label', this.isMinimized ? this.texts.interface.expand : this.texts.interface.minimize);
        btn.setAttribute('aria-expanded', !this.isMinimized);
        // Управляем видимостью кнопки popout
if (this.popoutBtn) {
    if (this.isMinimized) {
        this.popoutBtn.style.display = 'none';
    } else {
        this.popoutBtn.style.display = 'flex';
    }
}
    }
    
    // ✅ НОВОЕ: Управляем видимостью переключателя языков в шапке
    const languageDropdown = this.widget.querySelector('.webchat-language-dropdown');
    if (languageDropdown) {
        if (this.isMinimized) {
            languageDropdown.style.display = 'none';
        } else {
            languageDropdown.style.display = 'flex';
        }
    }
    
    // Автофокус при разворачивании
    if (!this.isMinimized && this.config.behavior && this.config.behavior.autoFocus) {
        setTimeout(() => {
            if (this.messageInput && !this.isMinimized) {
                this.messageInput.focus();
            }
        }, 100);
    }
    
    // ✅ НОВОЕ: Прокрутка к концу при разворачивании чата
    if (!this.isMinimized) {
        setTimeout(() => {
            this.scrollToBottom();
            this.log('debug', '📜 Прокрутка при разворачивании чата');
        }, 150);
    }

    // ✅ НОВОЕ: Управляем видимостью плавающего виджета
    this.updateFloatingWidgetVisibility();
}
// ✅ НОВОЕ: Обработка смены ориентации экрана
handleOrientationChange() {
    // Обновляем CSS переменную высоты viewport
    this.updateViewportHeight();
    
    // Сбрасываем масштабирование страницы
    const viewport = document.querySelector('meta[name="viewport"]');
    if (viewport) {
        viewport.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';
    }
    
    // Если чат развернут на мобильном - пересчитываем размеры
    if (this.isMobileDevice() && !this.isMinimized) {
        // Небольшая задержка для завершения смены ориентации
        setTimeout(() => {
            this.recalculateMobileSize();
            
            // Принудительно применяем полноэкранные стили
            this.applyMobileFullscreen();
            
            // Прокручиваем к последнему сообщению
            this.scrollToBottom();
        }, 100);
    }
}

// ✅ НОВОЕ: Обновление высоты viewport
updateViewportHeight() {
    const vh = window.innerHeight;
    document.documentElement.style.setProperty('--viewport-height', `${vh}px`);
}

// ✅ НОВОЕ: Пересчет размеров для мобильных
recalculateMobileSize() {
    if (!this.widget || !this.isMobileDevice()) return;

    if (!this.isMinimized) {
        this.widget.style.width = '100vw';
        this.widget.style.height = 'var(--viewport-height, 100vh)';
        this.widget.style.top = '0px';
        this.widget.style.left = '0px';
        this.widget.style.right = '0px';
        this.widget.style.bottom = '0px';
    }
}

// ✅ НОВОЕ: Мобильная анимация переключения
animateMobileToggle(wasMinimized) {

    this.updateViewportHeight();

    // Всегда используем компактный режим
    if (wasMinimized) {
        // РАЗВОРАЧИВАЕМ: компактный -> полноэкранный
        this.expandFromCompact();
    } else {
        // СВОРАЧИВАЕМ: полноэкранный -> компактный
        this.collapseToCompact();
    }

    this.manageMobileBodyScroll();
}

// ✅ НОВЫЙ МЕТОД: Разворачивание из компактного режима
expandFromCompact() {
    // 0. ✅ КРИТИЧЕСКИ ВАЖНО: Показываем виджет перед анимацией
    this.widget.style.display = 'flex';

    // 1. Отключаем все анимации
    this.widget.style.transition = 'none';

    // 2. Принудительно применяем полноэкранное позиционирование ДО удаления классов
    // Это предотвращает "скачок" графики
    this.applyMobileFullscreen();

    // 3. Принудительный reflow для применения стилей
    void this.widget.offsetHeight;

    // 4. Теперь убираем класс minimized
    this.widget.classList.remove('webchat-minimized');

    // 5. Принудительный reflow
    void this.widget.offsetHeight;

    // 6. Включаем анимацию только для opacity
    requestAnimationFrame(() => {
        this.widget.style.transition = 'opacity 0.3s ease-in-out';
        this.widget.style.opacity = '1';
    });
}

// ✅ НОВЫЙ МЕТОД: Сворачивание чата
collapseToCompact() {
    // Скрываем основной виджет
    this.widget.style.display = 'none';
    this.widget.classList.add('webchat-minimized');
}

// ✅ НОВОЕ: Разворачивание мобильного чата
expandMobileChat() {
    this.widget.style.display = 'flex';
    this.widget.classList.add('webchat-expanding');
    this.widget.classList.remove('webchat-minimized', 'webchat-collapsing');

    this.widget.style.width = '';
    this.widget.style.height = '';
    this.widget.style.maxWidth = '';
    this.widget.style.minHeight = '';

    setTimeout(() => {
        if (this.widget) {
            this.widget.classList.remove('webchat-expanding');
            this.applyMobileFullscreen();
        }
    }, 400);
}

// ✅ НОВОЕ: Сворачивание мобильного чата
collapseMobileChat() {
    this.widget.classList.add('webchat-collapsing');
    this.widget.classList.remove('webchat-expanding');

    setTimeout(() => {
        if (this.widget) {
            this.widget.classList.remove('webchat-collapsing');
            this.widget.classList.add('webchat-minimized');
            this.widget.style.display = 'none';
        }
    }, 400);
}

// ✅ НОВОЕ: Применение полноэкранных стилей
applyMobileFullscreen() {
    if (!this.widget || !this.isMobileDevice()) return;
    
    this.widget.style.position = 'fixed';
    this.widget.style.top = '0px';
    this.widget.style.left = '0px';
    this.widget.style.right = '0px';
    this.widget.style.bottom = '0px';
    this.widget.style.width = '100vw';
    this.widget.style.height = '100vh';
    this.widget.style.maxWidth = 'none';
    this.widget.style.maxHeight = 'none';
    this.widget.style.borderRadius = '0px';
    this.widget.style.margin = '0px';
    this.widget.style.zIndex = '999999';
    this.widget.style.transform = 'none'; // ✅ ДОБАВИТЬ: сброс transform
    
    // ✅ НОВОЕ: Скрываем overflow на body для предотвращения прокрутки
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.width = '100%';
    document.body.style.height = '100%';
    document.body.style.top = '0';
    document.body.style.left = '0';
    
}

// ✅ НОВОЕ: Управление прокруткой фона
manageMobileBodyScroll() {
    if (this.isMobileDevice()) {
        if (this.isMinimized) {
            document.body.style.overflow = '';
            document.body.style.position = '';
            document.body.style.width = '';
            document.body.style.height = '';
        } else {
            document.body.style.overflow = 'hidden';
            document.body.style.position = 'fixed';
            document.body.style.width = '100%';
            document.body.style.height = '100%';
        }
    }
}

// ✅ НОВОЕ: Настройка обработчиков ориентации
setupOrientationHandlers() {
    window.addEventListener('orientationchange', () => {
        setTimeout(() => {
            this.handleOrientationChange();
        }, 100);
    });
    
    window.addEventListener('resize', () => {
        if (this.isMobileDevice()) {
            this.updateViewportHeight();
            
            if (!this.isMinimized) {
                setTimeout(() => {
                    this.recalculateMobileSize();
                }, 50);
            }
        }
    });
    
}

// ✅ НОВОЕ: Настройка обработчика изменения размера окна
setupResizeHandler() {
    let resizeTimeout;
    
    const handleResize = () => {
        // Очищаем предыдущий таймер
        clearTimeout(resizeTimeout);
        
        // Устанавливаем новый таймер (дебаунс)
        resizeTimeout = setTimeout(() => {
            
            // Проверяем изменение режима
            this.checkModeChange();
            
            // Обновляем viewport height
            this.updateViewportHeight();
            
            // Если чат развернут и сейчас мобильный режим
            if (!this.isMinimized && this.isMobileDevice()) {
                this.recalculateMobileSize();
            }
            
        }, 150); // Задержка 150мс для производительности
    };
    
    // Добавляем обработчик
    window.addEventListener('resize', handleResize);
    
    // Сохраняем ссылку для очистки
    this.resizeHandler = handleResize;
    
}

    // ==============================================
    // ✅ НОВЫЕ МЕТОДЫ УПРАВЛЕНИЯ ПЕРЕКЛЮЧАТЕЛЕМ
    // ==============================================

    // Обновление настроек переключателя
    updateSwitcherSettings() {
        this.showConfigSwitcher = this.shouldShowSwitcher();
        this.availableConfigs = this.getAvailableConfigs();
        
        // Если переключатель должен быть скрыт, удаляем его из DOM
        const existingSwitcher = this.widget.querySelector('.webchat-config-switcher');
        if (!this.showConfigSwitcher && existingSwitcher) {
            existingSwitcher.remove();
        }
        
        // Если переключатель должен быть показан, но его нет - добавляем
        if (this.showConfigSwitcher && !existingSwitcher) {
            this.addConfigSwitcherToHeader();
        }
        
        // Обновляем опции в существующем переключателе
        if (this.showConfigSwitcher && this.configSelect) {
            this.updateConfigSelectOptions();
        }
        
        this.log('debug', '🔄 Настройки переключателя обновлены:', {
            show: this.showConfigSwitcher,
            availableConfigs: Object.keys(this.availableConfigs).length
        });
    }

    // Добавление переключателя в шапку
    addConfigSwitcherToHeader() {
        const headerInfo = this.widget.querySelector('.webchat-header-info');
        const minimizeBtn = this.widget.querySelector('.webchat-minimize-btn');
        
        if (headerInfo && minimizeBtn) {
            const configSelectHTML = this.generateConfigSelectHTML();
            if (configSelectHTML) {
                minimizeBtn.insertAdjacentHTML('beforebegin', configSelectHTML);
                this.configSelect = document.getElementById('webchatConfigSelect');
                
                // Настраиваем обработчики для нового переключателя
                if (this.configSelect) {
                    this.setupConfigSelectEvents();
                }
            }
        }
    }

   // Обновление опций в переключателе
updateConfigSelectOptions() {
    if (!this.configSelect) return;
    
    // ✅ НОВОЕ: Передаем текущий язык
    const sortedConfigs = window.getSortedConfigsForUI ? window.getSortedConfigsForUI(this.currentLanguage) : this.getSortedConfigsForUI(this.currentLanguage);
        
    // Очищаем текущие опции
    this.configSelect.innerHTML = '';
    
    // Добавляем новые опции
    sortedConfigs.forEach(config => {
        const option = document.createElement('option');
        option.value = config.value;
        option.textContent = config.label;
        if (config.value === this.currentConfigName) {
            option.selected = true;
        }
        this.configSelect.appendChild(option);
    });
}

    // Программное включение/отключение переключателя
    setConfigSwitcherEnabled(enabled) {
        const wasEnabled = this.showConfigSwitcher;
        
        // Обновляем глобальные настройки если доступны
        if (window.ChatConfigManager) {
            window.ChatConfigManager.setConfigSwitcherEnabled(enabled);
        }
        
        // Обновляем локальные настройки
        this.updateSwitcherSettings();
        
        if (wasEnabled !== enabled) {
            this.log('info', `🎛️ Переключатель конфигураций ${enabled ? 'ВКЛЮЧЕН' : 'ОТКЛЮЧЕН'}`);
        }
    }

    // Программное включение/отключение конкретной конфигурации
    setConfigEnabled(configName, enabled) {
        // Обновляем глобальные настройки если доступны
        if (window.ChatConfigManager) {
            window.ChatConfigManager.setConfigEnabled(configName, enabled);
        }
        
        // Обновляем локальные настройки
        this.updateSwitcherSettings();
        
        this.log('info', `📋 Конфигурация ${configName}: ${enabled ? 'ВКЛЮЧЕНА' : 'ОТКЛЮЧЕНА'}`);
    }

// ✅ НОВЫЕ МЕТОДЫ ДЛЯ СИСТЕМЫ КОНТАКТОВ

    // ✅ УЛУЧШЕННОЕ: Проверка - нужно ли показывать кнопку контактов
shouldShowContacts() {
    // Проверяем текущую конфигурацию
    const contacts = this.config.contacts;
    
    if (!contacts) {
        return false;
    }
    
    if (!contacts.enabled) {
        return false;
    }
    
    if (!contacts.items || !Array.isArray(contacts.items) || contacts.items.length === 0) {
        return false;
    }
    
    return true;
}

    // Генерация HTML кнопки контактов
    generateContactsHTML() {
        if (!this.shouldShowContacts()) return '';
        
       // ✅ ИСПРАВЛЕНО: Используем новую функцию локализации
const contactsTitle = this.getLocalizedContactsTitle();
const contactsTooltip = this.texts.contacts?.tooltip || contactsTitle;

return `
    <div class="webchat-contacts-container" style="position: relative;">
        <button class="webchat-contacts-btn" onclick="webChat.toggleContacts()" title="${contactsTooltip}">
            📞
        </button>
        <div class="webchat-contacts-popup" id="webchatContactsPopup">
            <div class="webchat-contacts-title">${contactsTitle}</div>
            <div class="webchat-contacts-grid">
                ${this.generateContactItems()}
            </div>
        </div>
    </div>
`;
    }

    // Генерация иконок контактов
    generateContactItems() {
        return this.config.contacts.items.map(contact => {
    const icon = this.getContactIcon(contact.type);
    const className = `webchat-contact-icon webchat-contact-${contact.type}`;
    const localizedLabel = this.getLocalizedContactLabel(contact); // ✅ НОВОЕ: локализованный label
    
    return `
        <a href="${contact.url}" 
           class="${className}" 
           target="_blank" 
           rel="noopener noreferrer"
           onclick="webChat.trackContactClick('${contact.type}')">
            ${icon}
            <span class="webchat-contact-tooltip">${localizedLabel}</span>
        </a>
    `;
}).join('');
    }

    // Получение иконки для типа контакта
    getContactIcon(type) {
        const icons = {
            telegram: '✈️',
            whatsapp: '📱', 
            email: '📧',
            twitter: '𝕏',
            instagram: '📷',
            messenger: '💬',
            phone: '📞'
        };
        return icons[type] || '📞';
    }

    // Переключение отображения контактов
    toggleContacts() {
        const popup = document.getElementById('webchatContactsPopup');
        if (!popup) return;
        
        const isVisible = popup.classList.contains('show');
        
        if (isVisible) {
            popup.classList.remove('show');
            this.log('debug', '📞 Popup контактов скрыт');
        } else {
            // Скрываем другие открытые popup
            this.hideAllPopups();
            popup.classList.add('show');
            this.log('debug', '📞 Popup контактов показан');
        }
    }

    // Скрытие всех popup
    hideAllPopups() {
        const popup = document.getElementById('webchatContactsPopup');
        if (popup) {
            popup.classList.remove('show');
        }
        // ✅ НОВОЕ: Закрываем выпадающее меню языков
        this.hideLanguageDropdown();
    }

    // Отслеживание кликов по контактам
    trackContactClick(contactType) {
        this.log('info', `📞 Переход по контакту: ${contactType}`);
        
        // Можно добавить аналитику
        if (typeof gtag !== 'undefined') {
            gtag('event', 'contact_click', {
                'contact_type': contactType,
                'config_name': this.currentConfigName
            });
        }
    }

    // ==============================================
    // ОТПРАВКА И ПОЛУЧЕНИЕ СООБЩЕНИЙ
    // ==============================================

    // Отправка обычного сообщения
    async sendMessage() {
        const messageText = this.messageInput.value.trim();

        // ✅ НОВОЕ: Проверяем есть ли текст или файл
        if (!messageText && !this.currentFile) return;

        // ✅ КРИТИЧЕСКАЯ ЗАЩИТА: Проверяем rate limiting
        const rateLimitCheck = this.checkRateLimit();
        if (!rateLimitCheck.allowed) {
            this.showError(rateLimitCheck.message);
            this.log('warn', '⚠️ Rate limit:', rateLimitCheck);
            return;
        }

        // ✅ УЛУЧШЕННАЯ ВАЛИДАЦИЯ: Проверяем текст с помощью новой функции валидации
        if (messageText) {
            const maxLength = this.config.technical?.maxMessageLength ?? 1000;
            const validation = this.validateTextInput(messageText, maxLength);

            if (!validation.valid) {
                this.showError(this.texts.errors?.invalidInput || 'Invalid input');
                this.log('warn', '⚠️ Валидация не прошла:', validation.error);
                return;
            }
        }

        // ✅ КРИТИЧЕСКАЯ ВАЛИДАЦИЯ: Проверяем файл
        if (this.currentFile) {
            const fileValidation = this.validateFile(this.currentFile);

            if (!fileValidation.valid) {
                this.showError(fileValidation.error);
                this.log('error', '❌ Файл не прошел валидацию:', fileValidation.error);
                this.clearFile();
                return;
            }
        }

        // ✅ Записываем временную метку сообщения для rate limiting
        this.recordMessageTimestamp();

        // ✅ РАСШИРЕННАЯ ОТЛАДКА: Определяем тип сообщения
        let messageType = 'text';
        let fileData = null;

        if (this.currentFile) {
            messageType = 'file';
            
            // Конвертируем файл в base64
            try {
                fileData = await this.fileToBase64(this.currentFile);
            } catch (error) {
                this.log('error','❌ Ошибка конвертации файла:', error);
                this.showError(this.texts.interface.fileError);
                return;
            }
        }


        // ✅ НОВОЕ: Добавляем сообщение в UI с файлом если есть
        if (this.currentFile) {
            await this.addFileMessage(messageText, this.currentFile, 'user');
        } else {
            this.addMessage(messageText, 'user');
        }

        // Очищаем поле ввода и файл
        this.messageInput.value = '';
        this.messageInput.style.height = 'auto';
        this.messageInput.style.height = Math.min(this.messageInput.scrollHeight, 120) + 'px';
        
        // ✅ НОВОЕ: Показываем индикатор загрузки файла
        if (this.currentFile) {
            this.showFileUploading();
        }
        
        const currentFile = this.currentFile; // Сохраняем ссылку
        this.clearFile(); // Очищаем текущий файл
        
        this.saveChatHistory();
        // ✅ НОВОЕ: Увеличиваем счетчик сообщений для мониторинга
this.monitoring.messageCount++;
this.monitoring.lastActivityTime = new Date().toISOString();

// Отправляем событие сообщения
this.sendMonitoringData('message');
        // Синхронизируем Session ID при отправке сообщения
        if (this.sessionId) {
            this.setCookie('webchat_session_id', this.sessionId, 365);
            this.log('debug', '🔄 Session ID синхронизирован при отправке сообщения');
        }

        const aiResponse = await this.sendMessageToAI(messageText, messageType, null, fileData);
        
        // ✅ НОВОЕ: Скрываем индикатор загрузки
        this.hideFileUploading();
        
        this.handleAIResponse(aiResponse);
    }

    // Отправка быстрого сообщения
    sendQuickMessage(message) {
        this.messageInput.value = message;
        this.sendMessage();
    }

    // Отправка сообщения в AI
    async sendMessageToAI(messageText, messageType, audioData, fileData) {
        // Устанавливаем значения по умолчанию
        messageType = messageType || 'text';
        audioData = audioData || null;
        fileData = fileData || null;
        
        try {
            this.updateStatus('connecting');
            this.showTypingIndicator();
            
            // ✅ УЛУЧШЕННАЯ ПЕРЕДАЧА ЯЗЫКА
const actualLanguage = this.currentLanguage || this.config.language || 'ru';

const messageData = {
    platform: 'webchat',
    message_text: messageText,
    user_id: this.extractUserId(),
    user_name: this.extractUserName(),
    session_id: this.sessionId,
    language: actualLanguage,
    messageType: messageType,
    
    content: {
        text: messageText,
        metadata: {
            timestamp: new Date().toISOString(),
            userAgent: navigator.userAgent,
            url: window.location.href,
            referrer: document.referrer,
            chatLanguage: actualLanguage,
            currentConfig: this.currentConfigName,
            configLanguage: this.config.language
        }
    },
            
    platformCapabilities: {
        supportsVoice: this.config.behavior ? this.config.behavior.enableVoice : false,
        supportsButtons: this.config.behavior ? this.config.behavior.showQuickButtons : false,
        supportsCustomUI: true,
        maxTextLength: this.config.technical ? this.config.technical.maxMessageLength : 1000,
        realTime: true,
        configSwitcher: this.showConfigSwitcher,
        // ✅ НОВОЕ: поддержка файлов
        supportsFiles: this.fileSettings.enableFileUpload,
        supportsPasteImages: this.fileSettings.enablePasteImages,
        maxFileSize: this.fileSettings.maxFileSize,
        allowedFileTypes: this.fileSettings.allowedTypes
    }
};

            if (audioData && messageType === 'voice') {
                messageData.content.voice = {
                    audioData: audioData,
                    format: 'wav'
                };
                messageData.voice_data = audioData;
                messageData.voice_format = 'wav';
            }

// ✅ ИСПРАВЛЕНИЕ: Обработка файлов с проверкой данных
            if (fileData && messageType === 'file') {
                
                if (fileData.data) {
                    messageData.content.file = {
                        fileData: fileData.data,
                        fileName: fileData.name,
                        fileType: fileData.type,
                        fileSize: fileData.size,
                        format: fileData.format
                    };
                    messageData.file_data = fileData.data;
                    messageData.file_name = fileData.name;
                    messageData.file_type = fileData.type;
                    messageData.file_size = fileData.size;
                    messageData.file_format = fileData.format;
                    
                } else {
                    this.log('error','❌ fileData.data отсутствует!');
                    throw new Error('Ошибка: данные файла не загружены');
                }
            }

            const controller = new AbortController();
const self = this;
const timeoutId = setTimeout(function() { 
    controller.abort(); 
}, this.config.technical ? this.config.technical.requestTimeout : 180000);

// ✅ РАСШИРЕННОЕ ЛОГИРОВАНИЕ для файлов
this.log('debug', `📤 Отправляем в AI:`, {
    messageType: messageData.messageType,
    hasFile: !!(messageData.file_data),
    language: messageData.language,
    chatLanguage: messageData.content.metadata.chatLanguage,
    configLanguage: messageData.content.metadata.configLanguage,
    currentConfig: this.currentConfigName,
    fileInfo: messageData.file_data ? {
        fileName: messageData.file_name,
        fileType: messageData.file_type,
        fileSize: messageData.file_size,
        dataLength: messageData.file_data ? messageData.file_data.length : 0
    } : null
});

// ✅ ЛОГИРУЕМ ПОЛНУЮ СТРУКТУРУ СООБЩЕНИЯ (без файловых данных)
const logData = { ...messageData };
if (logData.file_data) {
    logData.file_data = `[BASE64_DATA_${logData.file_data.length}_CHARS]`;
}
if (logData.content && logData.content.file && logData.content.file.fileData) {
    logData.content.file.fileData = `[BASE64_DATA_${logData.content.file.fileData.length}_CHARS]`;
}

const response = await this.fetchWithRetry(this.config.aiCoreUrl, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest', // ✅ CSRF защита
        'X-Session-ID': this.sessionId // ✅ Дополнительная идентификация
    },
    body: JSON.stringify(messageData),
    signal: controller.signal
});

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const contentType = response.headers.get('content-type');
            let aiResponse;

            try {
                if (contentType && contentType.includes('audio')) {
                    
                    // ✅ ЕДИНСТВЕННОЕ ЧТЕНИЕ response
                    const audioBlob = await response.blob();
                    
                    aiResponse = {
                        responseType: 'voice',
                        content: {
                            voice: { audioBlob: audioBlob },
                            text: this.texts.system.voiceMessage
                        }
                    };
                } else {
                    // ✅ ЕДИНСТВЕННОЕ ЧТЕНИЕ для текста
                    const responseText = await response.text();
                    try {
                        aiResponse = JSON.parse(responseText);
                    } catch (parseError) {
                        aiResponse = {
                            responseType: 'text',
                            content: { text: responseText || this.texts.errors.fallbackMessage }
                        };
                    }

                    if (!aiResponse.content) {
                        aiResponse = {
                            responseType: 'text',
                            content: {
                                text: aiResponse.response_text || aiResponse.text || aiResponse.message || this.texts.errors.fallbackMessage
                            }
                        };
                    }
                }
            } catch (responseError) {
    this.log('error','❌ ОШИБКА ЧТЕНИЯ ОТВЕТА:', responseError);
    aiResponse = {
        responseType: 'text',
        content: { text: `❌ ${this.texts.errors.connectionError}: ${responseError.message}` }
    };
}

this.updateStatus('connected');
this.hideTypingIndicator();

return aiResponse;

} catch (error) {
    this.log('error', '❌ AI Core communication error:', error);

    // ✅ УЛУЧШЕННАЯ ОБРАБОТКА ОШИБОК: Детальная классификация
    let errorMessage = this.texts.errors.connectionError;
    let errorType = 'unknown';

    // ✅ КРИТИЧЕСКАЯ БЕЗОПАСНОСТЬ: Классификация типов ошибок
    if (error.name === 'AbortError') {
        errorType = 'timeout';
        errorMessage = this.texts.errors?.timeoutError || this.texts.errors.connectionError;
    } else if (error.message.includes('NetworkError') || error.message.includes('Failed to fetch')) {
        errorType = 'network';
        errorMessage = this.texts.errors?.networkError || this.texts.errors.connectionError;
    } else if (error.message.includes('413')) {
        errorType = 'payload_too_large';
        errorMessage = messageType === 'file'
            ? `📦 ${this.texts.interface.fileTooLarge}`
            : (this.texts.errors?.dataSizeError || this.texts.errors.connectionError);
    } else if (error.message.includes('400')) {
        errorType = 'bad_request';
        errorMessage = this.texts.errors?.badRequest || this.texts.errors.connectionError;
    } else if (error.message.includes('401') || error.message.includes('403')) {
        errorType = 'auth_error';
        errorMessage = this.texts.errors?.authError || this.texts.errors.connectionError;
    } else if (error.message.includes('404')) {
        errorType = 'not_found';
        errorMessage = this.texts.errors?.serviceUnavailable || this.texts.errors.connectionError;
    } else if (error.message.includes('429')) {
        errorType = 'rate_limit';
        errorMessage = this.texts.errors?.rateLimitError || this.texts.errors.connectionError;
    } else if (error.message.includes('500') || error.message.includes('502') ||
               error.message.includes('503') || error.message.includes('504')) {
        errorType = 'server_error';
        errorMessage = this.texts.errors?.serverError || this.texts.errors.connectionError;
    } else if (messageType === 'file') {
        if (error.message.includes('unsupported') || error.message.includes('not allowed')) {
            errorType = 'file_type_error';
            errorMessage = `❌ ${this.texts.interface.fileTypeNotAllowed}`;
        } else {
            errorType = 'file_error';
            errorMessage = `❌ ${this.texts.interface.fileError}`;
        }
    }

    // Логируем тип ошибки для мониторинга
    this.log('error', `❌ Тип ошибки: ${errorType}`, {
        message: error.message,
        name: error.name,
        stack: error.stack
    });

    this.updateStatus('error');
    this.hideTypingIndicator();

    return {
        responseType: 'text',
        content: {
            text: `${errorMessage}<br><br>${this.texts.errors.fallbackMessage}`
        },
        error: {
            type: errorType,
            message: error.message
        }
    };
}
    }

    // Обработка ответа AI
handleAIResponse(response) {
    // 🎥 НОВОЕ: Проверка на видео
    if (response.responseType === 'video' && response.content.video) {
        console.log('🎥 Получен видео-ответ от AI');
        this.addVideoMessage(
            response.content.video,      // videoData (url, thumbnail, duration)
            response.content.text         // текст сопровождения
        );
    }
    // 🎤 Проверка на голос
    else if (response.responseType === 'voice' && response.content.voice) {
        this.addVoiceMessageFromAI(response.content.voice.audioBlob, response.content.text);
    }
    // 📝 Обычный текст
    else {
        const responseText = response.content && response.content.text ? response.content.text : (response.response_text || this.texts.system.connecting);

        // 🎬 НОВОЕ: Проверяем включена ли анимация для текстовых ответов от бота
        const animSettings = GlobalConfigSettings.streamingAnimation || {};
        const isAnimationEnabled = animSettings.enabled !== undefined ? animSettings.enabled : true;

        if (isAnimationEnabled) {
            // Используем анимированное отображение
            this.addMessageWithAnimation(responseText, 'bot');
        } else {
            // Используем обычное отображение
            this.addMessage(responseText, 'bot');
        }
    }

    if (response.commands) {
        this.handleCommands(response.commands);
    }

    this.saveChatHistory();
}

    // ==============================================
    // УПРАВЛЕНИЕ СООБЩЕНИЯМИ
    // ==============================================

    // Добавление текстового сообщения
addMessage(content, type) {
    const timestamp = new Date().toISOString();
    
    // Проверяем нужно ли добавить заголовок даты
    const lastMessage = this.chatHistory[this.chatHistory.length - 1];
    if (this.shouldShowDateHeader(timestamp, lastMessage?.timestamp)) {
        this.addDateHeader(timestamp);
    }
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `webchat-message webchat-${type}`;
    
    const avatar = document.createElement('div');
    avatar.className = `webchat-message-avatar webchat-${type}-avatar`;
    avatar.textContent = type === 'bot' ? this.config.botInfo.avatar : (this.config.userInfo && this.config.userInfo.avatar ? this.config.userInfo.avatar : '👤');
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'webchat-message-content';

    // ✅ ИСПРАВЛЕНИЕ: Безопасная вставка HTML с санитизацией и преобразованием ссылок
    const linkedContent = this.linkifyText(content);
    contentDiv.innerHTML = this.sanitizeHTML(linkedContent);
    
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    
    // Добавляем время к сообщению
    this.addTimeToMessage(messageDiv, timestamp);
    
    this.messagesContainer.appendChild(messageDiv);
    this.scrollToBottom();

    // Сохраняем в истории с timestamp
    this.chatHistory.push({
        type: type,
        content: content,
        timestamp: timestamp,
        config: this.currentConfigName
    });

    // Ограничиваем количество сообщений в истории
    const maxMessages = this.config.behavior ? this.config.behavior.maxHistoryMessages : 50;
    if (this.chatHistory.length > maxMessages) {
        this.chatHistory = this.chatHistory.slice(-maxMessages);
    }

    // ✅ КРИТИЧЕСКАЯ ОПТИМИЗАЦИЯ: Очищаем старые сообщения из DOM
    this.cleanupOldMessages();
}

// 🎬 НОВАЯ ФУНКЦИЯ: Разбивка HTML на части для анимации
splitHTMLIntoChunks(htmlContent, chunkType = 'sentence') {
    const chunks = [];

    // Создаем временный контейнер для парсинга HTML
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = this.sanitizeHTML(htmlContent);

    // Функция для извлечения текста и разбивки на части
    const processNode = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent;
            if (!text.trim()) return [];

            let parts = [];
            if (chunkType === 'sentence') {
                // Разбиваем по предложениям (по точке, вопросительному и восклицательному знакам)
                parts = text.split(/([.!?]+\s+|[.!?]+$)/g).filter(part => part.trim());
            } else if (chunkType === 'line') {
                // Разбиваем по переносам строк или параграфам
                parts = text.split(/(\n+|<br\s*\/?>)/gi).filter(part => part.trim());
            } else if (chunkType === 'word') {
                // Разбиваем по словам
                parts = text.split(/(\s+)/g).filter(part => part.trim());
            } else {
                parts = [text];
            }

            return parts.map(part => ({ type: 'text', content: part }));
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            // Для HTML элементов сохраняем структуру
            const element = node.cloneNode(false);
            const childChunks = [];

            for (let child of node.childNodes) {
                childChunks.push(...processNode(child));
            }

            // Если элемент имеет дочерние части, оборачиваем их
            if (childChunks.length > 0) {
                return childChunks.map(chunk => ({
                    type: 'element',
                    tagName: node.tagName.toLowerCase(),
                    attributes: Array.from(node.attributes).reduce((acc, attr) => {
                        acc[attr.name] = attr.value;
                        return acc;
                    }, {}),
                    content: chunk
                }));
            }

            return [{ type: 'element', element: element.outerHTML }];
        }

        return [];
    };

    // Обрабатываем все узлы
    for (let child of tempDiv.childNodes) {
        chunks.push(...processNode(child));
    }

    // Если не удалось разбить, возвращаем весь HTML как один кусок
    if (chunks.length === 0) {
        return [{ type: 'html', content: htmlContent }];
    }

    return chunks;
}

// 🎬 НОВАЯ ФУНКЦИЯ: Добавление сообщения с анимацией
async addMessageWithAnimation(content, type) {
    const timestamp = new Date().toISOString();

    // ✅ ВАЖНО: Сразу сохраняем полное сообщение в историю
    this.chatHistory.push({
        type: type,
        content: content,
        timestamp: timestamp,
        config: this.currentConfigName
    });

    // Ограничиваем количество сообщений в истории
    const maxMessages = this.config.behavior ? this.config.behavior.maxHistoryMessages : 50;
    if (this.chatHistory.length > maxMessages) {
        this.chatHistory = this.chatHistory.slice(-maxMessages);
    }

    // Проверяем нужно ли добавить заголовок даты
    const lastMessage = this.chatHistory[this.chatHistory.length - 2]; // -2 потому что только что добавили
    if (this.shouldShowDateHeader(timestamp, lastMessage?.timestamp)) {
        this.addDateHeader(timestamp);
    }

    // Создаем контейнер сообщения
    const messageDiv = document.createElement('div');
    messageDiv.className = `webchat-message webchat-${type}`;

    const avatar = document.createElement('div');
    avatar.className = `webchat-message-avatar webchat-${type}-avatar`;
    avatar.textContent = type === 'bot' ? this.config.botInfo.avatar : (this.config.userInfo && this.config.userInfo.avatar ? this.config.userInfo.avatar : '👤');

    const contentDiv = document.createElement('div');
    contentDiv.className = 'webchat-message-content';
    // 🎬 ПЛАВНОЕ ПОЯВЛЕНИЕ КОНТЕЙНЕРА
    contentDiv.style.opacity = '0';
    contentDiv.style.transition = 'opacity 0.4s ease-in-out';

    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);

    // Добавляем время к сообщению
    this.addTimeToMessage(messageDiv, timestamp);

    // Добавляем в DOM (пока пустой)
    this.messagesContainer.appendChild(messageDiv);
    this.scrollToBottom();

    // Получаем настройки анимации
    const animSettings = GlobalConfigSettings.streamingAnimation || {};
    const speed = animSettings.speed || 50;
    const chunkType = animSettings.chunkType || 'sentence';

    // 🎬 ПЛАВНО ПОКАЗЫВАЕМ КОНТЕЙНЕР (с небольшой задержкой для применения transition)
    await new Promise(resolve => setTimeout(resolve, 50));
    contentDiv.style.opacity = '1';
    await new Promise(resolve => setTimeout(resolve, 300)); // Ждем завершения fade-in контейнера

    // Разбиваем контент на части (с преобразованием ссылок)
    const linkedContent = this.linkifyText(content);
    const sanitizedContent = this.sanitizeHTML(linkedContent);

    // Простая разбивка: разделяем по предложениям с сохранением HTML
    let chunks = [];
    if (chunkType === 'sentence') {
        // Разбиваем по предложениям (целое предложение = текст + знак + пробелы)
        // Используем match вместо split чтобы получить целые предложения
        const sentences = sanitizedContent.match(/[^.!?]+[.!?]+\s*/g) || [];
        chunks = sentences.length > 0 ? sentences : [sanitizedContent];
    } else if (chunkType === 'line') {
        // Разбиваем по строкам (каждая строка включает перенос в конце)
        const lines = sanitizedContent.split(/(<br\s*\/?>|\n)/gi).filter(s => s.length > 0);
        // Объединяем строку + разделитель в один chunk
        chunks = [];
        for (let i = 0; i < lines.length; i += 2) {
            const line = lines[i] || '';
            const separator = lines[i + 1] || '';
            if (line || separator) {
                chunks.push(line + separator);
            }
        }
        // Если после объединения пусто, берем весь контент
        if (chunks.length === 0) chunks = [sanitizedContent];
    } else if (chunkType === 'word') {
        // Разбиваем по словам, сохраняя пробелы между словами
        chunks = sanitizedContent.split(/(\s+)/g).filter(s => s.length > 0);
    } else {
        chunks = [sanitizedContent];
    }

    // 🎬 АНИМИРОВАННОЕ ДОБАВЛЕНИЕ ЧАСТЕЙ С ПЛАВНЫМ ПОЯВЛЕНИЕМ
    let accumulatedHTML = '';
    let previousHTML = '';

    for (let i = 0; i < chunks.length; i++) {
        // Сохраняем предыдущий HTML
        previousHTML = accumulatedHTML;

        // Накапливаем HTML
        accumulatedHTML += chunks[i];

        // 🎬 СОЗДАЕМ ВРЕМЕННЫЙ SPAN для анимации ТОЛЬКО новой части
        const tempSpan = `<span class="webchat-streaming-chunk">${chunks[i]}</span>`;
        contentDiv.innerHTML = previousHTML + tempSpan;

        // Прокручиваем вниз
        this.scrollToBottom();

        // 🎬 ЖДЕМ чтобы анимация была видна (60% от длительности анимации)
        // Анимация 400ms, ждем 240ms = анимация успевает проиграться до 60%
        const animationWait = Math.max(50, speed);
        await new Promise(resolve => setTimeout(resolve, animationWait));

        // 🎬 УДАЛЯЕМ span после того как анимация стала видна
        contentDiv.innerHTML = accumulatedHTML;
    }

    // Финальная очистка - удаляем все оставшиеся span
    contentDiv.innerHTML = accumulatedHTML;

    // ✅ КРИТИЧЕСКАЯ ОПТИМИЗАЦИЯ: Очищаем старые сообщения из DOM
    this.cleanupOldMessages();
}

// ✅ ПОЛНЫЙ МЕТОД addVoiceMessage - С СОХРАНЕНИЕМ В ИСТОРИЮ
async addVoiceMessage(audioBlob, text) {

  // ✅ НОВОЕ: Загружаем голосовое сообщение на сервер
let voiceUrl = null;
const voiceSettings = this.config.technical?.voiceSettings || {};

if (voiceSettings.enableServerStorage) {
    try {
        voiceUrl = await this.uploadVoiceToServer(audioBlob);
    } catch (error) {
        this.log('error','❌ Ошибка загрузки голосового сообщения:', error);
        // Продолжаем работу даже если загрузка не удалась
    }
} else {

}

    // ✅ СОЗДАЕМ КОНТЕЙНЕР БЕЗ СТАНДАРТНОГО ФОНА СООБЩЕНИЯ
    const messageDiv = document.createElement('div');
    messageDiv.className = 'webchat-message webchat-bot';
    // ✅ ДОБАВЛЯЕМ КАСТОМНЫЙ КЛАСС ДЛЯ ГОЛОСОВЫХ СООБЩЕНИЙ
    messageDiv.classList.add('webchat-voice-message');
    
    const avatar = document.createElement('div');
    avatar.className = 'webchat-message-avatar webchat-bot-avatar';
    avatar.textContent = this.config.botInfo.avatar;
    
    // ✅ СОЗДАЕМ КОНТЕНТ БЕЗ СТАНДАРТНЫХ СТИЛЕЙ
    const contentDiv = document.createElement('div');
    contentDiv.className = 'webchat-message-content webchat-voice-content-wrapper';
    // ✅ УБИРАЕМ СТАНДАРТНЫЕ СТИЛИ СООБЩЕНИЯ
    contentDiv.style.background = 'transparent';
    contentDiv.style.border = 'none';
    contentDiv.style.padding = '0';
    contentDiv.style.boxShadow = 'none';
    contentDiv.style.borderRadius = '0';
    
    // ✅ СОЗДАЕМ ТОЛЬКО КАСТОМНЫЙ ПЛЕЕР БЕЗ ДОПОЛНИТЕЛЬНОГО ТЕКСТА
    const audioContainer = document.createElement('div');
    audioContainer.className = 'webchat-audio-message';
    
    // Скрытый audio элемент
    const audio = document.createElement('audio');
    audio.src = URL.createObjectURL(audioBlob);
    audio.preload = 'metadata';
    
    // Кнопка воспроизведения
    const playBtn = document.createElement('button');
    playBtn.className = 'webchat-voice-play-btn';
    playBtn.innerHTML = `
        <span class="play-icon">▶</span>
        <span class="pause-icon">⏸</span>
    `;
    
    // Контейнер для волн и информации
    const contentContainer = document.createElement('div');
    contentContainer.className = 'webchat-voice-content';
    
    // Волновая анимация
    const waveform = document.createElement('div');
    waveform.className = 'webchat-voice-waveform';
    
    // Создаем волны (случайной высоты) с использованием DocumentFragment для оптимизации
    const waveCount = 30;
    const waves = [];
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < waveCount; i++) {
        const wave = document.createElement('div');
        wave.className = 'webchat-voice-wave';
        wave.style.height = Math.random() * 16 + 4 + 'px';
        fragment.appendChild(wave);
        waves.push(wave);
    }
    waveform.appendChild(fragment);
    
    // Прогресс бар
    const progressContainer = document.createElement('div');
    progressContainer.className = 'webchat-voice-progress';
    const progressBar = document.createElement('div');
    progressBar.className = 'webchat-voice-progress-bar';
    progressContainer.appendChild(progressBar);
    
    // Информация о времени и размере
    const infoContainer = document.createElement('div');
    infoContainer.className = 'webchat-voice-info';
    
    const timeDisplay = document.createElement('span');
    timeDisplay.className = 'webchat-voice-time';
    timeDisplay.textContent = '0:00';
    
    const sizeDisplay = document.createElement('span');
    sizeDisplay.className = 'webchat-voice-size';
    sizeDisplay.textContent = this.formatFileSize(audioBlob.size);
    
    infoContainer.appendChild(timeDisplay);
    infoContainer.appendChild(sizeDisplay);
    
    // Собираем контент
    contentContainer.appendChild(waveform);
    contentContainer.appendChild(progressContainer);
    contentContainer.appendChild(infoContainer);
    
    audioContainer.appendChild(playBtn);
    audioContainer.appendChild(contentContainer);
    audioContainer.appendChild(audio); // скрытый
    
    // ✅ ДОБАВЛЯЕМ ТОЛЬКО ПЛЕЕР БЕЗ ДОПОЛНИТЕЛЬНОГО ТЕКСТА
    contentDiv.appendChild(audioContainer);
    
    // ✅ ЛОГИКА ВОСПРОИЗВЕДЕНИЯ (без изменений)
    let isPlaying = false;
    let animationInterval = null;
    let progressInterval = null;
    
    // Обновление времени
    const formatTime = (seconds) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };
    
    // Анимация волн
    const animateWaves = (progress = 0) => {
        waves.forEach((wave, index) => {
            const delay = index * 100;
            const shouldAnimate = (Date.now() + delay) % 1600 < 800;
            
            if (shouldAnimate) {
                wave.classList.add('animating', 'active');
            } else {
                wave.classList.remove('animating', 'active');
            }
            
            // Показываем прогресс
            if (index / waves.length <= progress) {
                wave.classList.add('active');
            } else if (!shouldAnimate) {
                wave.classList.remove('active');
            }
        });
    };
    
    // Обработчик загрузки метаданных
    audio.addEventListener('loadedmetadata', () => {
        const duration = audio.duration;
        if (!isNaN(duration)) {
            timeDisplay.textContent = formatTime(duration);
        }
    });
    
    // Обработчик воспроизведения
    playBtn.addEventListener('click', () => {
        if (isPlaying) {
            // Пауза
            audio.pause();
            playBtn.classList.remove('playing');
            isPlaying = false;
            
            // Останавливаем анимации
            if (animationInterval) {
                clearInterval(animationInterval);
                animationInterval = null;
            }
            if (progressInterval) {
                clearInterval(progressInterval);
                progressInterval = null;
            }
            
            waves.forEach(wave => {
                wave.classList.remove('animating');
            });
            
        } else {
            // Воспроизведение
            audio.play().then(() => {
                playBtn.classList.add('playing');
                isPlaying = true;
                
                // Запускаем анимацию волн
                animationInterval = setInterval(() => {
                    const progress = audio.currentTime / audio.duration;
                    animateWaves(progress);
                }, 100);
                
                // Обновляем прогресс
                progressInterval = setInterval(() => {
                    if (audio.duration) {
                        const progress = (audio.currentTime / audio.duration) * 100;
                        progressBar.style.width = progress + '%';
                        timeDisplay.textContent = formatTime(audio.currentTime);
                    }
                }, 100);
                
            }).catch(error => {
                this.log('error','❌ Ошибка воспроизведения:', error);
                playBtn.classList.remove('playing');
                isPlaying = false;
            });
        }
    });
    
    // Обработчик окончания воспроизведения
    audio.addEventListener('ended', () => {
        playBtn.classList.remove('playing');
        isPlaying = false;
        progressBar.style.width = '0%';

        if (animationInterval) {
            clearInterval(animationInterval);
            animationInterval = null;
        }
        if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
        }

        waves.forEach(wave => {
            wave.classList.remove('animating', 'active');
        });

        // Сбрасываем время
        if (audio.duration) {
            timeDisplay.textContent = formatTime(audio.duration);
        }
    });

    // ✅ ИСПРАВЛЕНИЕ УТЕЧКИ ПАМЯТИ: Добавляем cleanup для освобождения URL
    const cleanup = () => {
        if (animationInterval) {
            clearInterval(animationInterval);
            animationInterval = null;
        }
        if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
        }

        // Освобождаем URL объект
        if (audio.src && audio.src.startsWith('blob:')) {
            URL.revokeObjectURL(audio.src);
        }
    };

    // ✅ Отслеживаем удаление элемента из DOM
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.removedNodes.forEach((node) => {
                if (node.contains && node.contains(audio)) {
                    cleanup();
                    observer.disconnect();
                }
            });
        });
    });

    // Наблюдаем за родительским контейнером
    if (audio.parentNode) {
        observer.observe(this.messagesContainer, { childList: true, subtree: true });
    }

    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    this.messagesContainer.appendChild(messageDiv);
    
    this.scrollToBottom();
    

    // ✅ ОБНОВЛЕНО: Сохранение в истории с временем
    const timestamp = new Date().toISOString();
    
    // Проверяем нужно ли добавить заголовок даты
    const lastMessage = this.chatHistory[this.chatHistory.length - 1];
    if (this.shouldShowDateHeader(timestamp, lastMessage?.timestamp)) {
        // Для голосовых сообщений добавляем дату ПЕРЕД сообщением
        const existingMessage = messageDiv.parentNode ? messageDiv : null;
        if (existingMessage) {
            existingMessage.remove();
        }
        
        this.addDateHeader(timestamp);
        
        if (existingMessage) {
            this.messagesContainer.appendChild(existingMessage);
        }
    }
    
    // Добавляем время к голосовому сообщению
    this.addTimeToMessage(messageDiv, timestamp);
    
   this.chatHistory.push({
    type: 'video',
    content: text || '', // ← Пустая строка вместо дефолта
    videoUrl: videoData.url,
    timestamp: timestamp,
    config: this.currentConfigName
});

    
    // Сохраняем обновленную историю
    this.saveChatHistory();
}

    // ✅ УСИЛЕННАЯ прокрутка к последнему сообщению
    scrollToBottom() {
        if (!this.messagesContainer) return;
        
        // Принудительная прокрутка в конец
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        
        // Дополнительная проверка через requestAnimationFrame
        requestAnimationFrame(() => {
            if (this.messagesContainer) {
                this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
            }
        });
        
        this.log('debug', `📜 Прокрутка: scrollTop=${this.messagesContainer.scrollTop}, scrollHeight=${this.messagesContainer.scrollHeight}`);
    }

    // ==============================================
    // ГОЛОСОВЫЕ СООБЩЕНИЯ
    // ==============================================

    // Переключение записи голоса
    async toggleVoiceRecording() {
        if (!this.config.behavior || !this.config.behavior.enableVoice) return;

        const voiceBtn = this.voiceBtn;
        
        if (!this.isRecording) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                this.mediaRecorder = new MediaRecorder(stream);
                const audioChunks = [];
                
                this.mediaRecorder.ondataavailable = function(event) {
                    if (event.data && event.data.size > 0) {
                        audioChunks.push(event.data);
                    }
                };

                this.mediaRecorder.onstop = async function() {
                    // ✅ ИСПРАВЛЕНИЕ: Используем реальный MIME тип от MediaRecorder
                    const mimeType = this.mediaRecorder.mimeType || 'audio/webm;codecs=opus';
                    const audioBlob = new Blob(audioChunks, { type: mimeType });

                    this.log('info', '🎤 Голосовое сообщение записано:', {
                        size: this.formatFileSize(audioBlob.size),
                        type: mimeType,
                        chunks: audioChunks.length
                    });

                    await this.processVoiceMessage(audioBlob);
                }.bind(this);

                // ✅ ИСПРАВЛЕНИЕ: Добавляем timeslice (1 секунда) для надежной записи
                this.mediaRecorder.start(1000);
                this.isRecording = true;
                
                voiceBtn.classList.add('webchat-recording');
                voiceBtn.innerHTML = '⏹️';
                
                // Автоостановка через максимальное время
                setTimeout(function() {
                    if (this.isRecording) {
                        this.toggleVoiceRecording();
                    }
                }.bind(this), (this.config.technical ? this.config.technical.maxVoiceDuration : 60) * 1000);
                
            } catch (error) {
                this.log('error','❌ Ошибка доступа к микрофону:', error);
                this.showError(this.texts.errors.microphoneAccess);
            }
        } else {
            this.isRecording = false;
            voiceBtn.classList.remove('webchat-recording');
            voiceBtn.innerHTML = '⏳';
            voiceBtn.disabled = true;
            
            this.mediaRecorder.stop();
            this.mediaRecorder.stream.getTracks().forEach(function(track) { 
                track.stop(); 
            });
        }
    }

    // Обработка голосового сообщения
    async processVoiceMessage(audioBlob) {
    const voiceBtn = document.getElementById('webchatVoiceBtn');
    
    try {
        if (!(audioBlob instanceof Blob) || audioBlob.size === 0) {
            throw new Error('Невалидные аудиоданные');
        }
        
        // Проверка размера файла (опционально)
        const maxSize = 10 * 1024 * 1024; // 10MB
        if (audioBlob.size > maxSize) {
            throw new Error('Голосовое сообщение слишком большое (максимум 10MB)');
        }
        
        // ИСПРАВЛЕННАЯ конвертация в base64
        const base64Audio = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                // Убираем префикс data:audio/wav;base64, и оставляем только base64
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = () => reject(new Error('Ошибка чтения аудио файла'));
            reader.readAsDataURL(audioBlob);
        });
        
        this.addMessage(this.texts.system.voiceMessage, 'user');

        const aiResponse = await this.sendMessageToAI('', 'voice', base64Audio);
        this.handleAIResponse(aiResponse);
        
    } catch (error) {
        this.log('error','❌ Ошибка обработки голоса:', error);
        this.showError(this.texts.errors.voiceProcessing);
    } finally {
        voiceBtn.innerHTML = '🎤';
        voiceBtn.disabled = false;
    }
}

// ✅ НОВЫЙ МЕТОД: Конвертация Blob в base64
    async blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                // Убираем префикс data:audio/ogg;base64, и оставляем только base64
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = () => reject(new Error('Ошибка конвертации Blob в base64'));
            reader.readAsDataURL(blob);
        });
    }

// Загрузка голосового сообщения на сервер
async uploadVoiceToServer(audioBlob, fromAI = false) {
    try {
        // Получаем настройки из конфигурации
        const voiceSettings = this.config.technical?.voiceSettings || {};
        
        // Проверяем включено ли сохранение на сервер
        if (!voiceSettings.enableServerStorage) {
            return null;
        }
        
        // Проверяем размер файла
        const maxSize = voiceSettings.maxVoiceSize || (5 * 1024 * 1024);
        if (audioBlob.size > maxSize) {
            throw new Error(`Голосовое сообщение слишком большое (максимум ${this.formatFileSize(maxSize)})`);
        }
        
        const formData = new FormData();
        const fileFormat = voiceSettings.fileFormat || 'ogg';
        const filePrefix = voiceSettings.filePrefix || 'voice_message_';
        const fileName = `${filePrefix}${Date.now()}.${fileFormat}`;
        
        formData.append('audio', audioBlob, fileName);
        formData.append('sessionId', this.sessionId);
        formData.append('timestamp', new Date().toISOString());
        formData.append('fromAI', fromAI ? 'true' : 'false');
        
        // Используем endpoint из настроек
        const uploadEndpoint = voiceSettings.uploadEndpoint || '/upload-voice.php';

        const response = await this.fetchWithRetry(uploadEndpoint, {
            method: 'POST',
            headers: {
                'X-Requested-With': 'XMLHttpRequest', // ✅ CSRF защита
                'X-Session-ID': this.sessionId // ✅ Дополнительная идентификация
            },
            body: formData
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        return data.url;
        
    } catch (error) {
        this.log('error','❌ Ошибка загрузки на сервер:', error);
        
        // Проверяем нужен ли локальный fallback
        const voiceSettings = this.config.technical?.voiceSettings || {};
        if (voiceSettings.enableLocalFallback) {
            // Здесь можно добавить локальное сохранение
        }
        
        throw error;
    }
}

// Загрузка голосового сообщения с сервера
async downloadVoiceFromServer(voiceUrl) {
    try {
        // Получаем настройки из конфигурации
        const voiceSettings = this.config.technical?.voiceSettings || {};
        
        // Если сохранение на сервер отключено, возвращаем null
        if (!voiceSettings.enableServerStorage) {
            return null;
        }
        
        // Если URL относительный, добавляем базовый путь
        let fullUrl = voiceUrl;
        if (voiceUrl && !voiceUrl.startsWith('http')) {
            const downloadEndpoint = voiceSettings.downloadEndpoint || '/voices/';
            fullUrl = downloadEndpoint + voiceUrl;
        }
        
        // Сначала проверяем доступность файла методом HEAD
        const checkResponse = await this.fetchWithRetry(fullUrl, {
            method: 'HEAD',
            headers: {
                'X-Requested-With': 'XMLHttpRequest' // ✅ CSRF защита
            }
        });

        if (!checkResponse.ok) {
            if (checkResponse.status === 404) {
                return null;
            }
            throw new Error(`HTTP error! status: ${checkResponse.status}`);
        }

        // Если файл доступен, загружаем его
        const response = await this.fetchWithRetry(fullUrl);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const blob = await response.blob();
        return blob;
        
    } catch (error) {
        // Не показываем ошибку 404 в консоли как критическую
        if (error.message && error.message.includes('404')) {
            return null;
        }
        
        this.log('error','❌ Ошибка загрузки с сервера:', error);
        return null; // Возвращаем null вместо выброса ошибки
    }
}

    // ✅ НОВЫЙ МЕТОД: Конвертация base64 обратно в Blob
    base64ToBlob(base64Data, mimeType = 'audio/ogg') {
        try {
            const byteCharacters = atob(base64Data);
            const byteNumbers = new Array(byteCharacters.length);
            
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            
            const byteArray = new Uint8Array(byteNumbers);
            return new Blob([byteArray], { type: mimeType });
        } catch (error) {
            this.log('error','❌ Ошибка конвертации base64 в Blob:', error);
            return null;
        }
    }
    // ==============================================
    // ИНДИКАТОРЫ И СТАТУСЫ
    // ==============================================

    // Обновление статуса подключения
    updateStatus(status) {
        if (!this.statusIndicator) return;
        
        this.statusIndicator.classList.remove('webchat-connecting', 'webchat-error', 'webchat-connected');
        this.statusIndicator.classList.add(`webchat-${status}`);
        this.isConnected = (status === 'connected');
    }

    // Показать индикатор печати
    showTypingIndicator() {
        if (this.typingIndicator) {
            this.typingIndicator.classList.add('webchat-show');
            this.scrollToBottom();
        }
    }

    // Скрыть индикатор печати
    hideTypingIndicator() {
        if (this.typingIndicator) {
            this.typingIndicator.classList.remove('webchat-show');
        }
    }

    // Показать сообщение об ошибке
    showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'webchat-error-message';
    errorDiv.innerHTML = message;
    
    this.messagesContainer.appendChild(errorDiv);
    this.scrollToBottom();
    
    // Автоудаление через 5 секунд
    setTimeout(function() {
        if (errorDiv.parentNode) {
            errorDiv.parentNode.removeChild(errorDiv);
        }
    }, 5000);
}

    // ==============================================
    // ИСТОРИЯ ЧАТА
    // ==============================================

    // Проверка квоты хранилища и очистка при необходимости
    async checkStorageQuota() {
        if (!navigator.storage || !navigator.storage.estimate) {
            this.log('debug', 'Storage API недоступен, пропускаем проверку квоты');
            return;
        }

        try {
            const estimate = await navigator.storage.estimate();
            const usagePercent = (estimate.usage / estimate.quota) * 100;

            this.log('debug', `📊 Использовано хранилища: ${usagePercent.toFixed(2)}% (${this.formatFileSize(estimate.usage)} из ${this.formatFileSize(estimate.quota)})`);

            // Если использовано более 80% - очищаем старую историю
            if (usagePercent > 80) {
                this.log('warn', '⚠️ Хранилище заполнено более чем на 80%, очищаем старую историю');

                try {
                    const currentHistory = JSON.parse(localStorage.getItem('webchat_history') || '{"history":[]}');

                    // Оставляем только последние 20 сообщений
                    if (currentHistory.history && currentHistory.history.length > 20) {
                        currentHistory.history = currentHistory.history.slice(-20);
                        localStorage.setItem('webchat_history', JSON.stringify(currentHistory));
                        this.log('info', '✅ История сокращена до 20 последних сообщений');
                    }

                    // Удаляем старые голосовые данные из Blob URLs
                    this.cleanupOldBlobUrls();

                } catch (error) {
                    this.log('error', '❌ Ошибка очистки истории:', error);
                }
            }
        } catch (error) {
            this.log('error', '❌ Ошибка проверки квоты хранилища:', error);
        }
    }

    // Очистка старых Blob URLs
    cleanupOldBlobUrls() {
        // Удаляем старые URL из памяти (реальная очистка происходит через URL.revokeObjectURL)
        this.log('debug', '🧹 Очистка старых Blob URLs');
        // В будущем здесь можно добавить более сложную логику управления Blob URLs
    }

    // Сохранение истории чата
    async saveChatHistory() {
    if (!this.config.behavior || !this.config.behavior.saveHistory) return;

    // Проверяем квоту хранилища перед сохранением
    await this.checkStorageQuota();

    const historyData = {
        sessionId: this.sessionId,
        history: this.chatHistory.slice(-(this.config.behavior.maxHistoryMessages || 50)),
        timestamp: new Date().toISOString(),
        language: this.config.language,
        currentConfig: this.currentConfigName
    };
    
    try {
        localStorage.setItem('webchat_history', JSON.stringify(historyData));
        
        // Отладка сохранения
        const saved = JSON.parse(localStorage.getItem('webchat_history'));
        
    } catch (error) {
        this.log('warn','⚠️ Не удалось сохранить историю чата:', error);
        
        // Если превышена квота, пробуем сохранить без старых голосовых данных
        if (error.name === 'QuotaExceededError') {
            try {
                const compressedHistory = {
                    sessionId: historyData.sessionId,
                    timestamp: historyData.timestamp,
                    language: historyData.language,
                    currentConfig: historyData.currentConfig,
                    history: historyData.history.map((msg, index) => {
                        // Оставляем voiceData только для последних 2-3 голосовых сообщений
                        if (msg.type === 'voice' && msg.voiceData) {
                            const voiceMessages = historyData.history.filter(m => m.type === 'voice');
                            const voiceIndex = voiceMessages.indexOf(msg);
                            if (voiceIndex < voiceMessages.length - 2) {
                                return { ...msg, voiceData: null };
                            }
                        }
                        return msg;
                    })
                };
                
                localStorage.setItem('webchat_history', JSON.stringify(compressedHistory));
            } catch (secondError) {
                this.log('error','❌ Критическая ошибка сохранения:', secondError);
            }
        }
    }
}

    // Загрузка истории чата
    loadChatHistory() {
    if (!this.config.behavior || !this.config.behavior.saveHistory) return;
    
    try {
        const historyData = localStorage.getItem('webchat_history');
        if (historyData) {
            const parsed = JSON.parse(historyData);
            const historyLifetime = this.config.behavior.historyLifetime || 24;
            const maxAge = new Date(Date.now() - historyLifetime * 60 * 60 * 1000);
            
            if (new Date(parsed.timestamp) > maxAge && parsed.sessionId === this.sessionId) {
                this.chatHistory = parsed.history || [];
                
                // ✅ ИСПРАВЛЕНО: Удаляем приветственное сообщение только если showWelcome включено и есть история
if (this.chatHistory.length > 0) {
    if (this.config.behavior && this.config.behavior.showWelcome) {
        const welcomeMsg = this.messagesContainer.querySelector('.webchat-message.webchat-bot');
        if (welcomeMsg) {
            welcomeMsg.remove();
            this.log('debug', '🗑️ Приветственное сообщение удалено (есть история)');
        }
    }
    
    // ✅ ИСПРАВЛЕНО: Восстанавливаем сообщения ПОСЛЕДОВАТЕЛЬНО для сохранения порядка
    const restoreMessagesInOrder = async () => {
        for (const msg of this.chatHistory) {
            await this.restoreMessageFromHistory(msg);
        }
        
        // Прокрутка после восстановления всех сообщений
        this.scrollToBottom();
    };
    
    // Запускаем последовательное восстановление
    restoreMessagesInOrder();
                    
                    // ✅ ИСПРАВЛЕНИЕ: Принудительная прокрутка к концу
                    this.log('debug', '📜 Восстанавливаем историю, прокручиваем к концу');
                    setTimeout(() => {
                        this.scrollToBottom();
                    }, 50);
                    setTimeout(() => {
                        this.scrollToBottom();
                    }, 200);
                    setTimeout(() => {
                        this.scrollToBottom();
                    }, 500);
                }
            }
        }
    } catch (error) {
        this.log('warn','⚠️ Не удалось загрузить историю чата:', error);
    }
}

// ✅ НОВЫЙ МЕТОД: Добавление голосового сообщения из истории (БЕЗ повторного сохранения)
async addVoiceMessageFromHistory(audioBlob, text) {

    // ✅ СОЗДАЕМ ТОТ ЖЕ UI КАК В addVoiceMessage(), НО БЕЗ СОХРАНЕНИЯ В ИСТОРИЮ
    const messageDiv = document.createElement('div');
    messageDiv.className = 'webchat-message webchat-bot webchat-voice-message';
    
    const avatar = document.createElement('div');
    avatar.className = 'webchat-message-avatar webchat-bot-avatar';
    avatar.textContent = this.config.botInfo.avatar;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'webchat-message-content webchat-voice-content-wrapper';
    contentDiv.style.background = 'transparent';
    contentDiv.style.border = 'none';
    contentDiv.style.padding = '0';
    contentDiv.style.boxShadow = 'none';
    contentDiv.style.borderRadius = '0';
    
    // ✅ СОЗДАЕМ ГОЛОСОВОЙ ПЛЕЕР (переиспользуем метод)
    const audioContainer = this.createVoicePlayer(audioBlob);
    contentDiv.appendChild(audioContainer);
    
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    this.messagesContainer.appendChild(messageDiv);
    
}

// Добавление голосового сообщения от ИИ с сохранением на сервер
async addVoiceMessageFromAI(audioBlob, text) {

    // Загружаем на сервер
    let voiceUrl = null;
    const voiceSettings = this.config.technical?.voiceSettings || {};
    
    if (voiceSettings.enableServerStorage) {
        try {
            voiceUrl = await this.uploadVoiceToServer(audioBlob, true); // true = от ИИ
        } catch (error) {
            this.log('error','❌ Ошибка загрузки голосового сообщения ИИ:', error);
        }
    }

    // Создаем UI элемент (используем тот же код что в addVoiceMessage)
    const messageDiv = document.createElement('div');
    messageDiv.className = 'webchat-message webchat-bot webchat-voice-message';
    
    const avatar = document.createElement('div');
    avatar.className = 'webchat-message-avatar webchat-bot-avatar';
    avatar.textContent = this.config.botInfo.avatar;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'webchat-message-content webchat-voice-content-wrapper';
    contentDiv.style.background = 'transparent';
    contentDiv.style.border = 'none';
    contentDiv.style.padding = '0';
    contentDiv.style.boxShadow = 'none';
    contentDiv.style.borderRadius = '0';
    
    // Создаем голосовой плеер
    const audioContainer = this.createVoicePlayer(audioBlob);
    contentDiv.appendChild(audioContainer);
    
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    this.messagesContainer.appendChild(messageDiv);
    
    this.scrollToBottom();

    // Сохраняем в истории с URL вместо данных
    const timestamp = new Date().toISOString();
    
    // Проверяем нужно ли добавить заголовок даты
    const lastMessage = this.chatHistory[this.chatHistory.length - 1];
    if (this.shouldShowDateHeader(timestamp, lastMessage?.timestamp)) {
        this.addDateHeader(timestamp);
    }
    
    // Добавляем время к сообщению
    this.addTimeToMessage(messageDiv, timestamp);
    
    this.chatHistory.push({
        type: 'voice',
        content: text || this.texts.system.voiceMessage,
        voiceUrl: voiceUrl, // URL вместо данных
        fromAI: true, // Помечаем что от ИИ
        timestamp: timestamp,
        config: this.currentConfigName
    });

    // Сохраняем историю
    this.saveChatHistory();
}

// ✅ НОВЫЙ МЕТОД: Создание голосового плеера (вынесен отдельно для переиспользования)
createVoicePlayer(audioBlob) {
    const audioContainer = document.createElement('div');
    audioContainer.className = 'webchat-audio-message';
    
    // Скрытый audio элемент
    const audio = document.createElement('audio');
    audio.src = URL.createObjectURL(audioBlob);
    audio.preload = 'metadata';
    
    // Кнопка воспроизведения
    const playBtn = document.createElement('button');
    playBtn.className = 'webchat-voice-play-btn';
    playBtn.innerHTML = `
        <span class="play-icon">▶</span>
        <span class="pause-icon">⏸</span>
    `;
    
    // Контейнер для волн и информации
    const contentContainer = document.createElement('div');
    contentContainer.className = 'webchat-voice-content';
    
    // Волновая анимация
    const waveform = document.createElement('div');
    waveform.className = 'webchat-voice-waveform';
    
    // Создаем волны (случайной высоты) с использованием DocumentFragment для оптимизации
    const waveCount = 30;
    const waves = [];
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < waveCount; i++) {
        const wave = document.createElement('div');
        wave.className = 'webchat-voice-wave';
        wave.style.height = Math.random() * 16 + 4 + 'px';
        fragment.appendChild(wave);
        waves.push(wave);
    }
    waveform.appendChild(fragment);
    
    // Прогресс бар
    const progressContainer = document.createElement('div');
    progressContainer.className = 'webchat-voice-progress';
    const progressBar = document.createElement('div');
    progressBar.className = 'webchat-voice-progress-bar';
    progressContainer.appendChild(progressBar);
    
    // Информация о времени и размере
    const infoContainer = document.createElement('div');
    infoContainer.className = 'webchat-voice-info';
    
    const timeDisplay = document.createElement('span');
    timeDisplay.className = 'webchat-voice-time';
    timeDisplay.textContent = '0:00';
    
    const sizeDisplay = document.createElement('span');
    sizeDisplay.className = 'webchat-voice-size';
    sizeDisplay.textContent = this.formatFileSize(audioBlob.size);
    
    infoContainer.appendChild(timeDisplay);
    infoContainer.appendChild(sizeDisplay);
    
    // Собираем контент
    contentContainer.appendChild(waveform);
    contentContainer.appendChild(progressContainer);
    contentContainer.appendChild(infoContainer);
    
    audioContainer.appendChild(playBtn);
    audioContainer.appendChild(contentContainer);
    audioContainer.appendChild(audio); // скрытый
    
    // ✅ ДОБАВЛЯЕМ ВСЮ ЛОГИКУ ВОСПРОИЗВЕДЕНИЯ
    this.setupVoicePlayerLogic(audio, playBtn, waves, progressBar, timeDisplay);
    
    return audioContainer;
}

// Логика воспроизведения голосовых сообщений
setupVoicePlayerLogic(audio, playBtn, waves, progressBar, timeDisplay) {
    let isPlaying = false;
    let animationInterval = null;
    let progressInterval = null;
    
    // ✅ Функция очистки ресурсов
    const cleanup = () => {
        if (animationInterval) {
            clearInterval(animationInterval);
            animationInterval = null;
        }
        if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
        }
        
        // Освобождаем URL объект
        if (audio.src && audio.src.startsWith('blob:')) {
            URL.revokeObjectURL(audio.src);
        }
    };
    
    // ✅ Отслеживаем удаление элемента из DOM
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.removedNodes.forEach((node) => {
                if (node.contains && node.contains(audio)) {
                    cleanup();
                    observer.disconnect();
                }
            });
        });
    });
    
    // Наблюдаем за родительским контейнером
    if (audio.parentNode) {
        observer.observe(audio.parentNode, { childList: true, subtree: true });
    }
    
    // Обновление времени
    const formatTime = (seconds) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };
    
    // Анимация волн
    const animateWaves = (progress = 0) => {
        waves.forEach((wave, index) => {
            const delay = index * 100;
            const shouldAnimate = (Date.now() + delay) % 1600 < 800;
            
            if (shouldAnimate) {
                wave.classList.add('animating', 'active');
            } else {
                wave.classList.remove('animating', 'active');
            }
            
            // Показываем прогресс
            if (index / waves.length <= progress) {
                wave.classList.add('active');
            } else if (!shouldAnimate) {
                wave.classList.remove('active');
            }
        });
    };
    
    // Обработчик загрузки метаданных
    audio.addEventListener('loadedmetadata', () => {
        const duration = audio.duration;
        if (!isNaN(duration)) {
            timeDisplay.textContent = formatTime(duration);
        }
    });
    
    // Обработчик воспроизведения
    playBtn.addEventListener('click', () => {
        if (isPlaying) {
            // Пауза
            audio.pause();
            playBtn.classList.remove('playing');
            isPlaying = false;
            
            // Останавливаем анимации
            if (animationInterval) {
                clearInterval(animationInterval);
                animationInterval = null;
            }
            if (progressInterval) {
                clearInterval(progressInterval);
                progressInterval = null;
            }
            
            waves.forEach(wave => {
                wave.classList.remove('animating');
            });
            
        } else {
            // Воспроизведение
            audio.play().then(() => {
                playBtn.classList.add('playing');
                isPlaying = true;
                
                // Запускаем анимацию волн
                animationInterval = setInterval(() => {
                    const progress = audio.currentTime / audio.duration;
                    animateWaves(progress);
                }, 100);
                
                // Обновляем прогресс
                progressInterval = setInterval(() => {
                    if (audio.duration) {
                        const progress = (audio.currentTime / audio.duration) * 100;
                        progressBar.style.width = progress + '%';
                        timeDisplay.textContent = formatTime(audio.currentTime);
                    }
                }, 100);
                
            }).catch(error => {
                this.log('error','❌ Ошибка воспроизведения:', error);
                playBtn.classList.remove('playing');
                isPlaying = false;
            });
        }
    });
    
    // Обработчик окончания воспроизведения
    audio.addEventListener('ended', () => {
        playBtn.classList.remove('playing');
        isPlaying = false;
        progressBar.style.width = '0%';
        
        if (animationInterval) {
            clearInterval(animationInterval);
            animationInterval = null;
        }
        if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
        }
        
        waves.forEach(wave => {
            wave.classList.remove('animating', 'active');
        });
        
        // Сбрасываем время
        if (audio.duration) {
            timeDisplay.textContent = formatTime(audio.duration);
        }
    });
    
    // ✅ Очистка при выгрузке страницы
    window.addEventListener('beforeunload', cleanup);
}
    // Добавление сообщения только в UI (без сохранения в истории)
addMessageToUI(content, type, timestamp = null) {
    // ✅ НОВОЕ: Используем переданный timestamp или создаем новый
    const msgTimestamp = timestamp || new Date().toISOString();
    
    // ✅ НОВОЕ: Проверяем является ли это голосовым сообщением по содержимому
    if (content && content.includes('🎤 Голосовое сообщение')) {
        // Это fallback для голосового сообщения, которое не удалось восстановить
        const messageDiv = document.createElement('div');
        messageDiv.className = `webchat-message webchat-${type}`;
        
        const avatar = document.createElement('div');
        avatar.className = `webchat-message-avatar webchat-${type}-avatar`;
        avatar.textContent = type === 'bot' ? this.config.botInfo.avatar : (this.config.userInfo && this.config.userInfo.avatar ? this.config.userInfo.avatar : '👤');
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'webchat-message-content';

        // ✅ ИСПРАВЛЕНИЕ: Применяем linkifyText даже для fallback сообщений
        const linkedContent = this.linkifyText(content);
        contentDiv.innerHTML = this.sanitizeHTML(linkedContent);
        contentDiv.style.opacity = '0.7'; // Показываем что это fallback
        contentDiv.style.fontStyle = 'italic';
        
        messageDiv.appendChild(avatar);
        messageDiv.appendChild(contentDiv);
        
        // ✅ НОВОЕ: Добавляем время даже к fallback сообщениям
        this.addTimeToMessage(messageDiv, msgTimestamp);
        
        this.messagesContainer.appendChild(messageDiv);
        return;
    }
    
    // ✅ ОБЫЧНАЯ ЛОГИКА ДЛЯ ТЕКСТОВЫХ СООБЩЕНИЙ
    const messageDiv = document.createElement('div');
    messageDiv.className = `webchat-message webchat-${type}`;
    
    const avatar = document.createElement('div');
    avatar.className = `webchat-message-avatar webchat-${type}-avatar`;
    avatar.textContent = type === 'bot' ? this.config.botInfo.avatar : (this.config.userInfo && this.config.userInfo.avatar ? this.config.userInfo.avatar : '👤');
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'webchat-message-content';

    // ✅ ИСПРАВЛЕНИЕ: Применяем linkifyText для восстановленных сообщений
    const linkedContent = this.linkifyText(content);
    contentDiv.innerHTML = this.sanitizeHTML(linkedContent);

    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    
    // ✅ НОВОЕ: Добавляем время к сообщению
    this.addTimeToMessage(messageDiv, msgTimestamp);
    
    this.messagesContainer.appendChild(messageDiv);
}

    // Очистка истории чата
    clearHistory() {
        this.chatHistory = [];
        localStorage.removeItem('webchat_history');
        
        // Очищаем UI
        this.messagesContainer.innerHTML = '';
        
        // Показываем приветственное сообщение
        if (this.config.behavior && this.config.behavior.showWelcome) {
            this.messagesContainer.innerHTML = this.generateWelcomeMessage();
        }
    }

    // ==============================================
    // ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
    // ==============================================

    // Генерация Session ID
    generateSessionId() {
        // Пытаемся получить из разных источников
        let sessionId = localStorage.getItem('webchat_session_id') || 
                        sessionStorage.getItem('webchat_session_id') ||
                        this.getCookie('webchat_session_id');
        
        if (!sessionId) {
            const timestamp = Date.now();
            const random = Math.random().toString(36).substr(2, 9);
            sessionId = `webchat_${random}_${timestamp}`;
            
            // Сохраняем в несколько мест
            localStorage.setItem('webchat_session_id', sessionId);
            sessionStorage.setItem('webchat_session_id', sessionId);
            this.setCookie('webchat_session_id', sessionId, 365); // на год
            
            this.log('debug', '🆕 Created NEW permanent session_id:', sessionId);
            this.log('info', '💾 Session ID сохранен в 3 места для надежности');
        } else {
            // Синхронизируем во все хранилища
            localStorage.setItem('webchat_session_id', sessionId);
            sessionStorage.setItem('webchat_session_id', sessionId);
            this.setCookie('webchat_session_id', sessionId, 365);
            
            this.log('debug', '✅ Restored EXISTING session_id:', sessionId);
            this.log('info', '🔄 Session ID синхронизирован во все хранилища');
        }
        
        return sessionId;
    }
    
    // Получение cookie по имени
getCookie(name) {
    const cookies = document.cookie.split(';');
    for (let cookie of cookies) {
        const [cookieName, cookieValue] = cookie.trim().split('=');
        if (cookieName === name) {
            return cookieValue;
        }
    }
    return null;
}

    // Установка cookie
    setCookie(name, value, days) {
        const date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        const expires = `expires=${date.toUTCString()}`;

        // ✅ ИСПРАВЛЕНИЕ БЕЗОПАСНОСТИ: Добавляем Secure и SameSite=Strict
        // Примечание: HttpOnly нельзя установить из JavaScript (только на сервере)
        const isHttps = window.location.protocol === 'https:';
        const secureFlag = isHttps ? ';Secure' : ''; // Secure только для HTTPS
        document.cookie = `${name}=${value};${expires};path=/;SameSite=Strict${secureFlag}`;
    }

    // Извлечение ID пользователя
    extractUserId() {
        return this.sessionId.split('_')[1] || 'web_user';
    }

    // Извлечение имени пользователя из истории сообщений
    extractUserName() {
        const namePatterns = {
            ru: /меня зовут (\w+)|я (\w+)|имя (\w+)/i,
            en: /my name is (\w+)|i am (\w+)|call me (\w+)/i
        };
        
        const pattern = namePatterns[this.config.language] || namePatterns.ru;
        
        for (const msg of this.chatHistory) {
            if (msg.type === 'user') {
                const text = msg.content.toLowerCase();
                const nameMatch = text.match(pattern);
                if (nameMatch) {
                    return nameMatch[1] || nameMatch[2] || nameMatch[3];
                }
            }
        }
        return this.config.userInfo?.defaultName || this.texts.fallback?.defaultUserName || 'User';
    }

    // Обработка команд от AI
   handleCommands(commands) {
    // Получаем актуальные тексты для текущего языка
    const commandTexts = this.texts.commands || {};
    
    // 1. Голосовое предпочтение
    if (commands.voicePreference !== undefined) {
        const enableVoice = (commands.voicePreference === 'enabled' || commands.voicePreference === true);
        
        // Обновляем настройку
        if (this.config.behavior) {
            this.config.behavior.enableVoice = enableVoice;
        }
        
        // Обновляем UI кнопку голоса
        if (this.voiceBtn) {
            this.voiceBtn.style.display = enableVoice ? 'flex' : 'none';
        }
        
        // Показываем сообщение
        const message = enableVoice ? commandTexts.voiceEnabled : commandTexts.voiceDisabled;
        if (message) {
            this.addMessage(message, 'bot');
        }
        
        this.log('info', `🎤 Голосовые сообщения ${enableVoice ? 'включены' : 'отключены'}`);
    }
    
    // 2. Очистка истории
    if (commands.clearHistory) {
        this.clearHistory();
        
        // Показываем сообщение об очистке
        const clearedMessage = commandTexts.historyCleared;
        if (clearedMessage) {
            this.addMessage(clearedMessage, 'bot');
        }
        
        this.log('info', '🗑️ История чата очищена по команде AI');
    }
    
    // 3. Смена языка - КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ!
    if (commands.changeLanguage) {
        const newLanguage = commands.changeLanguage;
        
        // ✅ ИСПОЛЬЗУЕМ ПРАВИЛЬНЫЙ МЕТОД switchLanguage
        if (this.switchLanguage(newLanguage)) {
            this.log('info', `🌍 Язык изменен по команде AI на: ${newLanguage}`);
        } else {
            this.log('warn', `⚠️ Не удалось изменить язык на: ${newLanguage}`);
        }
    }
    
    // 4. Управление переключателем конфигураций
    if (commands.setSwitcherEnabled !== undefined) {
        this.setConfigSwitcherEnabled(commands.setSwitcherEnabled);
        this.log('info', `🎛️ Переключатель конфигураций ${commands.setSwitcherEnabled ? 'включен' : 'отключен'}`);
    }
    
    // 5. Включение конфигураций
    if (commands.enableConfigs && Array.isArray(commands.enableConfigs)) {
        commands.enableConfigs.forEach(configName => {
            this.setConfigEnabled(configName, true);
            this.log('info', `✅ Конфигурация ${configName} включена`);
        });
    }
    
    // 6. Отключение конфигураций
    if (commands.disableConfigs && Array.isArray(commands.disableConfigs)) {
        commands.disableConfigs.forEach(configName => {
            this.setConfigEnabled(configName, false);
            this.log('info', `❌ Конфигурация ${configName} отключена`);
        });
    }
    
    // 7. Переключение конфигурации
    if (commands.switchConfig) {
        const configName = commands.switchConfig;
        
        // Проверяем доступность конфигурации
        if (this.availableConfigs[configName]) {
            this.switchConfig(configName);
            
            // Формируем сообщение о переключении
            const switchMessage = commandTexts.configSwitched;
            if (switchMessage) {
                const configLabel = this.availableConfigs[configName].botInfo.name;
                this.addMessage(`${switchMessage} ${configLabel}`, 'bot');
            }
            
            this.log('info', `🔄 Конфигурация переключена на: ${configName}`);
        } else {
            this.log('warn', `⚠️ Конфигурация ${configName} недоступна`);
        }
    }
    
    // 8. Сворачивание/разворачивание чата
    if (commands.minimizeChat !== undefined) {
    const shouldMinimize = commands.minimizeChat;
    const delay = commands.minimizeChatDelay || 0; // Получаем задержку из команды
    
    // Функция сворачивания с задержкой
    const performMinimize = () => {
        // Проверяем текущее состояние
        if (this.isMinimized !== shouldMinimize) {
            this.toggleChat();
            this.log('info', `📐 Чат ${shouldMinimize ? 'свернут' : 'развернут'} по команде AI`);
        }
    };
    
    if (delay > 0 && shouldMinimize) {
        // Если есть задержка и нужно свернуть - устанавливаем таймер
        this.log('info', `⏱️ Чат будет свернут через ${delay / 1000} секунд`);
        setTimeout(performMinimize, delay);
    } else {
        // Без задержки - выполняем сразу
        performMinimize();
    }
}
    
    // 9. Показ уведомлений
    if (commands.showNotification) {
        const notification = commands.showNotification;
        if (notification.text) {
            const notificationType = notification.type || 'info';
            const icon = {
                'info': 'ℹ️',
                'success': '✅',
                'warning': '⚠️',
                'error': '❌'
            }[notificationType] || 'ℹ️';
            
            this.addMessage(`${icon} ${notification.text}`, 'bot');
            this.log('info', `📢 Показано уведомление: ${notification.text}`);
        }
    }
    
    // 10. Установка темы
    if (commands.setTheme) {
        const theme = commands.setTheme;
        if (['light', 'dark', 'auto'].includes(theme)) {
            this.setTheme(theme);
            
            const themeMessage = commandTexts.themeChanged;
            if (themeMessage) {
                this.addMessage(themeMessage, 'bot');
            }
            
            this.log('info', `🎨 Тема изменена на: ${theme}`);
        }
    }
    
    // 11. Фокус на поле ввода
    if (commands.focusInput) {
        setTimeout(() => {
            if (this.messageInput) {
                this.messageInput.focus();
            }
        }, 100);
        
        this.log('info', '📝 Фокус установлен на поле ввода');
    }
    
    // 12. Показ/скрытие контактов
    if (commands.showContacts !== undefined) {
        if (commands.showContacts && this.config.behavior && this.config.behavior.showContacts) {
            const contactsMessage = commandTexts.contactsShown;
            if (contactsMessage) {
                this.addMessage(contactsMessage, 'bot');
            }
            
            if (this.config.behavior.contacts) {
                this.showContactButtons();
            }
        }
        
        this.log('info', `📞 Контакты ${commands.showContacts ? 'показаны' : 'скрыты'}`);
    }
}

    // Обновление быстрых кнопок
    updateQuickButtons() {
        const quickActions = this.widget.querySelector('.webchat-quick-actions');
        if (!quickActions || !this.config.behavior || !this.config.behavior.showQuickButtons) return;
        
        // Обновляем содержимое
        const quickButtonsHTML = this.generateQuickButtonsHTML();
        const inputArea = this.widget.querySelector('.webchat-input-area');
        
        if (inputArea) {
            // Удаляем старые кнопки
            const oldQuickActions = inputArea.querySelector('.webchat-quick-actions');
            if (oldQuickActions) {
                oldQuickActions.remove();
            }
            
            // Добавляем новые кнопки в начало input-area
            if (quickButtonsHTML) {
                inputArea.insertAdjacentHTML('afterbegin', quickButtonsHTML);
            }
        }
    }

    // ==============================================
    // ПУБЛИЧНЫЕ МЕТОДЫ API
    // ==============================================

    // Отправка сообщения программно
    sendProgrammaticMessage(message) {
        this.messageInput.value = message;
        this.sendMessage();
    }

    // Получение истории чата
    getChatHistory() {
        return [...this.chatHistory];
    }

    // Получение статуса подключения
    getConnectionStatus() {
        return this.isConnected;
    }

    // Получение состояния чата (свернут/развернут)
    getMinimizedState() {
        return this.isMinimized;
    }

    // Программное сворачивание/разворачивание
    setMinimized(minimized) {
        if (this.isMinimized !== minimized) {
            this.toggleChat();
        }
    }

    // Обновление конфигурации
    updateConfig(newConfig) {
        if (this.config.updateConfig) {
            this.config.updateConfig(newConfig);
        }
        this.texts = this.config.getTexts ? this.config.getTexts() : this.texts;
        this.updateInterface();
        this.applyAppearanceSettings();
    }
    
   // Открытие чата в отдельном окне
openInPopout() {
    // Проверяем включен ли режим
    if (!this.config.behavior || !this.config.behavior.enablePopoutMode) {
        this.log('warn', '⚠️ Режим отдельного окна отключен');
        return;
    }
    
    // Получаем размеры окна из конфигурации
    const width = this.config.behavior.popoutWindowSize?.width || 500;
    const height = this.config.behavior.popoutWindowSize?.height || 770;
    
    // Вычисляем позицию окна по центру экрана
    const left = (window.screen.width - width) / 2;
    const top = (window.screen.height - height) / 2;
    
    // Параметры нового окна
    const windowFeatures = `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=no,toolbar=no,menubar=no,location=no,directories=no,status=no`;
    
    // Создаем уникальное имя для окна
    const windowName = 'webchat_popout_' + Date.now();
    
    // Открываем новое окно с пустой страницей вместо about:blank
const popoutWindow = window.open('', windowName, windowFeatures);
    
    if (!popoutWindow) {
        alert(this.texts.errors?.popupBlockedError || 'Failed to open window. Please check popup blocker settings.');
        return;
    }
    
    // ✅ НОВОЕ: Сохраняем текущую историю для передачи в popup
    const currentHistory = this.exportChatHistory();
    
    // Получаем текущий URL для загрузки стилей и скриптов
    const baseUrl = window.location.origin;
    
    // HTML для нового окна с автоматическим разворачиванием чата
    const popoutHTML = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${this.texts.headerTitle || 'Чат'}</title>
            <style>
                body {
                    margin: 0;
                    padding: 0;
                    overflow: hidden;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
                    background: #f3f4f6;
                }
                #chat-container {
                    width: 100vw;
                    height: 100vh;
                }
                /* Переопределяем стили для полноэкранного режима */
                .webchat-widget {
                    position: fixed !important;
                    display: flex !important;
                    top: 0 !important;
                    left: 0 !important;
                    right: 0 !important;
                    bottom: 0 !important;
                    width: 100% !important;
                    height: 100% !important;
                    max-width: 100% !important;
                    max-height: 100% !important;
                    border-radius: 0 !important;
                    margin: 0 !important;
                }
                /* Скрываем кнопку popout в popup окне */
                .webchat-popout-btn {
                    display: none !important;
                }
                /* Скрываем кнопку сворачивания в popup окне */
                .webchat-minimize-btn {
                    display: none !important;
                }
                /* Скрываем плавающий виджет в popout окне */
                #webchatFloatingWidget {
                    display: none !important;
                }
                /* Обеспечиваем правильные размеры для развернутого чата */
                .webchat-widget.webchat-minimized {
                    display: flex !important;
                    width: 100% !important;
                    height: 100% !important;
                }
                
            </style>
        </head>
        <body>
            <div id="chat-container"></div>
        </body>
        </html>
    `;
    
    // Записываем HTML в новое окно
    popoutWindow.document.write(popoutHTML);
    popoutWindow.document.close();
    
    // Копируем все стили
    const styles = document.querySelectorAll('link[rel="stylesheet"], style');
    styles.forEach(style => {
        if (style.href) {
            const newLink = popoutWindow.document.createElement('link');
            newLink.rel = 'stylesheet';
            newLink.href = style.href;
            popoutWindow.document.head.appendChild(newLink);
        } else if (style.tagName === 'STYLE' &&
                   !style.textContent.includes('webchat-popout-btn') &&
                   !style.hasAttribute('data-webchat-dynamic')) {
            // Не копируем стили виджетов (data-webchat-dynamic) в popout окно
            const newStyle = popoutWindow.document.createElement('style');
            newStyle.textContent = style.textContent;
            popoutWindow.document.head.appendChild(newStyle);
        }
    });
    
    // Подготавливаем конфигурацию для нового окна
    const popoutConfig = Object.assign({}, this.config);
    popoutConfig.behavior = Object.assign({}, popoutConfig.behavior);
    popoutConfig.behavior.enablePopoutMode = false; // Отключаем кнопку popout
    popoutConfig.behavior.autoOpen = true; // ВАЖНО: автоматически открываем чат
    
    // ✅ НОВОЕ: Копируем конфигурации ДИНАМИЧЕСКИ
popoutWindow.WebChatConfig = popoutConfig;
popoutWindow.currentChatHistory = currentHistory;

// Динамически копируем ВСЕ конфигурации
const availableConfigs = this.getAvailableConfigs();
for (let configName in availableConfigs) {
    popoutWindow[configName] = availableConfigs[configName];
    this.log('debug', `📋 Скопирована конфигурация в popout: ${configName}`);
}
    
    // Копируем другие необходимые глобальные функции
    popoutWindow.GlobalConfigSettings = window.GlobalConfigSettings;
    popoutWindow.ChatConfigManager = window.ChatConfigManager;
    popoutWindow.shouldShowConfigSwitcher = window.shouldShowConfigSwitcher;
    popoutWindow.getAvailableConfigs = window.getAvailableConfigs;
    popoutWindow.getSortedConfigsForUI = window.getSortedConfigsForUI;
    popoutWindow.getEffectiveTheme = window.getEffectiveTheme;
    
    // Загружаем скрипты
    setTimeout(() => {
        // Копируем необходимые скрипты
        const scripts = document.querySelectorAll('script');
        let scriptsToLoad = [];
        
        scripts.forEach(script => {
            if (script.src && (script.src.includes('webchat') || script.src.includes('config'))) {
                scriptsToLoad.push(script.src);
            }
        });
        
        // Функция последовательной загрузки скриптов
        let scriptIndex = 0;
        
        function loadNextScript() {
            if (scriptIndex < scriptsToLoad.length) {
                const scriptElement = popoutWindow.document.createElement('script');
                scriptElement.src = scriptsToLoad[scriptIndex];
                scriptElement.onload = () => {
                    scriptIndex++;
                    loadNextScript();
                };
                scriptElement.onerror = () => {
                    this.log('error','Ошибка загрузки скрипта:', scriptsToLoad[scriptIndex]);
                    scriptIndex++;
                    loadNextScript();
                };
                popoutWindow.document.body.appendChild(scriptElement);
            } else {
                // Все скрипты загружены, инициализируем чат
const initScript = popoutWindow.document.createElement('script');
                initScript.textContent = `
    // Ждем полной загрузки
    setTimeout(() => {
        if (typeof initWebChat === 'function') {
            // Временно меняем настройку autoOpen
            if (window.WebChatConfig && window.WebChatConfig.behavior) {
                window.WebChatConfig.behavior.autoOpen = true;
            }
            
            // Инициализируем чат
            window.webChat = initWebChat();
            
            // ✅ НОВОЕ: Импортируем историю из родительского окна
            if (window.currentChatHistory && window.webChat) {
                setTimeout(() => {
                    window.webChat.importChatHistory(window.currentChatHistory);
                }, 500);
            }
            
            // ✅ НОВОЕ: Настраиваем синхронизацию обратно при закрытии
            window.addEventListener('beforeunload', () => {
                if (window.opener && !window.opener.closed && window.opener.webChat) {
                    const historyToReturn = window.webChat.exportChatHistory();
                    window.opener.webChat.importChatHistory(historyToReturn);
                }
            });
            
            // ✅ НОВОЕ: Периодическое сохранение истории
            setInterval(() => {
                if (window.webChat) {
                    window.lastExportedHistory = window.webChat.exportChatHistory();
                }
            }, 2000);
            
            // Дополнительная проверка и разворачивание
            setTimeout(() => {
                if (window.webChat) {
                    // Принудительно разворачиваем если свернут
                    if (window.webChat.isMinimized) {
                        window.webChat.isMinimized = false;
                        window.webChat.widget.classList.remove('webchat-minimized');
                        
                        // Обновляем кнопку минимизации
                        const minimizeBtn = window.webChat.widget.querySelector('.webchat-minimize-btn');
                        if (minimizeBtn) {
                            minimizeBtn.textContent = '−';
                            minimizeBtn.title = 'Свернуть';
                        }

                    }
                    
                    // Блокируем автоматическое сворачивание
                    const originalToggleChat = window.webChat.toggleChat;
                    let firstToggle = true;
                    window.webChat.toggleChat = function() {
                        if (firstToggle) {
                            firstToggle = false;
                            // Игнорируем первый вызов toggleChat

                            return;
                        }
                        // Последующие вызовы работают нормально
                        originalToggleChat.call(this);
                    };
                }
            }, 2);
            
        } else {
            this.log('error','❌ initWebChat не найден');
        }
    }, 1);
`;
                popoutWindow.document.body.appendChild(initScript);
            }
        }
        
        loadNextScript();
        
    }, 100);
    
    // Скрываем текущий чат
    this.widget.style.display = 'none';
    
    // Обработчик закрытия окна
    const checkInterval = setInterval(() => {
        if (popoutWindow.closed) {
            clearInterval(checkInterval);
            
            // Показываем обратно исходный чат
            this.widget.style.display = '';
            
            // ✅ НОВОЕ: Принудительно обновляем историю (на случай если beforeunload не сработал)
            if (popoutWindow.lastExportedHistory) {
                this.importChatHistory(popoutWindow.lastExportedHistory);
            }
            
            this.log('info', '✅ Окно чата закрыто, чат возвращен на страницу с синхронизированной историей');
        }
    }, 500);
    
    this.log('info', '🚀 Чат открыт в отдельном окне');
}

// ✅ НОВЫЕ МЕТОДЫ УПРАВЛЕНИЯ ТЕМОЙ

    // Программное изменение темы
    setTheme(theme) {
        const validThemes = ['auto', 'light', 'dark'];
        if (!validThemes.includes(theme)) {
            this.log('error', '❌ Некорректная тема:', theme);
            return false;
        }
        
        this.currentTheme = theme;
        this.applyTheme(theme);
        
        this.log('info', `🎨 Тема изменена программно: ${theme}`);
        return true;
    }

    // Получение текущей темы
    getTheme() {
        return this.currentTheme;
    }

    // Получение информации о теме
    getThemeInfo() {
        return {
            current: this.currentTheme,
            config: this.config.theme ? this.config.theme.mode : null,
            effective: this.determineTheme(),
            available: ['auto', 'light', 'dark']
        };
    }

    // Переключение между светлой и темной темой
    toggleTheme() {
        const currentTheme = this.currentTheme;
        let newTheme;
        
        if (currentTheme === 'light') {
            newTheme = 'dark';
        } else if (currentTheme === 'dark') {
            newTheme = 'light';
        } else {
            // Если auto, определяем системную тему и переключаем на противоположную
            const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
            newTheme = prefersDark ? 'light' : 'dark';
        }
        
        return this.setTheme(newTheme);
    }

    // Применение темы с анимацией
    setThemeWithTransition(theme, duration = 300) {
        if (!this.widget) return false;
        
        // Добавляем CSS transition
        this.widget.style.transition = `all ${duration}ms ease-in-out`;
        
        // Применяем тему
        const success = this.setTheme(theme);
        
        // Убираем transition через указанное время
        setTimeout(() => {
            if (this.widget) {
                this.widget.style.transition = '';
            }
        }, duration);
        
        return success;
    }

    // Следование системной теме с автообновлением
    enableSystemThemeTracking() {
        if (!window.matchMedia) {
            this.log('warn', '⚠️ Отслеживание системной темы не поддерживается');
            return false;
        }
        
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        
        // Функция обновления темы
        const updateTheme = (e) => {
            if (this.currentTheme === 'auto') {
                this.applyTheme(); // Переприменяем auto тему
                this.log('info', `🎨 Системная тема изменена: ${e.matches ? 'dark' : 'light'}`);
            }
        };
        
        // Подписываемся на изменения
        if (mediaQuery.addListener) {
            mediaQuery.addListener(updateTheme);
        } else if (mediaQuery.addEventListener) {
            mediaQuery.addEventListener('change', updateTheme);
        }
        
        // Сохраняем ссылку для отключения
        this.systemThemeMediaQuery = mediaQuery;
        this.systemThemeHandler = updateTheme;
        
        this.log('info', '🎨 Отслеживание системной темы включено');
        return true;
    }

    // Отключение отслеживания системной темы
    disableSystemThemeTracking() {
        if (this.systemThemeMediaQuery && this.systemThemeHandler) {
            if (this.systemThemeMediaQuery.removeListener) {
                this.systemThemeMediaQuery.removeListener(this.systemThemeHandler);
            } else if (this.systemThemeMediaQuery.removeEventListener) {
                this.systemThemeMediaQuery.removeEventListener('change', this.systemThemeHandler);
            }
            
            this.systemThemeMediaQuery = null;
            this.systemThemeHandler = null;
            
            this.log('info', '🎨 Отслеживание системной темы отключено');
            return true;
        }
        return false;
    }

// ✅ НОВЫЕ МЕТОДЫ УПРАВЛЕНИЯ КОНТАКТАМИ

    // Программное открытие/закрытие контактов
    showContacts() {
        const popup = document.getElementById('webchatContactsPopup');
        if (popup) {
            this.hideAllPopups();
            popup.classList.add('show');
            return true;
        }
        return false;
    }

    hideContacts() {
        const popup = document.getElementById('webchatContactsPopup');
        if (popup) {
            popup.classList.remove('show');
            return true;
        }
        return false;
    }

// ✅ НОВЫЙ МЕТОД: Экспорт истории чата
    exportChatHistory() {
        return {
            messages: this.chatHistory,
            sessionId: this.sessionId,
            currentConfig: this.currentConfigName,
            timestamp: new Date().toISOString()
        };
    }

    // ✅ НОВЫЙ МЕТОД: Импорт истории чата
async importChatHistory(historyData) {
    if (!historyData || !historyData.messages) return;
    
    // Очищаем текущие сообщения в UI
    this.messagesContainer.innerHTML = '';
    
    
    // Импортируем историю
    this.chatHistory = historyData.messages;
    
    
    // Восстанавливаем сообщения в UI
for (const msg of this.chatHistory) {
    await this.restoreMessageFromHistory(msg);
}

    // Прокручиваем к последнему сообщению
    setTimeout(() => {
        this.scrollToBottom();
    }, 100);
    
    // ✅ НОВОЕ: Переинициализируем систему дат если она была удалена
    if (!this.messagesContainer.querySelector('.webchat-scroll-date')) {
        this.setupScrollDateHandlers();
    }
}

// Проверка, есть ли уже сообщение в DOM
isMessageAlreadyInDOM(msg) {
    const messages = this.messagesContainer.querySelectorAll('.webchat-message');
    
    // Для голосовых сообщений проверяем по другим критериям
    if (msg.type === 'voice') {
        const voiceMessages = this.messagesContainer.querySelectorAll('.webchat-voice-message');
        
        // Считаем количество голосовых сообщений с таким же timestamp в истории
        const voiceCountInHistory = this.chatHistory.filter(m => 
            m.type === 'voice' && m.timestamp === msg.timestamp
        ).length;
        
        // Считаем количество голосовых сообщений в DOM
        const voiceCountInDOM = voiceMessages.length;
        
        // Если в DOM уже есть столько же или больше голосовых, не добавляем
        if (voiceCountInDOM >= voiceCountInHistory) {
            return true;
        }
        
        return false;
    }
    
    // Для обычных сообщений проверяем по timestamp
    for (let messageEl of messages) {
        const timeEl = messageEl.querySelector('.webchat-message-time');
        if (timeEl && timeEl.getAttribute('data-timestamp') === msg.timestamp) {
            return true;
        }
    }
    
    return false;
}

    // Получение информации о контактах
    getContactsInfo() {
        return {
            enabled: this.shouldShowContacts(),
            title: this.config.contacts ? this.config.contacts.title : null,
            items: this.config.contacts ? this.config.contacts.items : [],
            totalContacts: this.config.contacts && this.config.contacts.items ? this.config.contacts.items.length : 0
        };
    }
    
    // ✅ НОВЫЙ МЕТОД: Получение локализованного заголовка контактов
getLocalizedContactsTitle() {
    if (!this.config.contacts) return this.texts.contacts?.title || 'Контакты';
    
    const contactsConfig = this.config.contacts;
    const currentLanguage = this.currentLanguage || this.config.language || 'ru';
    
    // Проверяем многоязычную структуру
    if (contactsConfig.titles && typeof contactsConfig.titles === 'object') {
        return contactsConfig.titles[currentLanguage] || 
               contactsConfig.titles.ru || 
               contactsConfig.titles.en || 
               this.texts.contacts?.title || 
               'Контакты';
    }
    
    // Fallback на старую структуру
    if (contactsConfig.title) {
        return contactsConfig.title;
    }
    
    // Fallback на базовые тексты
    return this.texts.contacts?.title || 'Контакты';
}

// ✅ НОВЫЙ МЕТОД: Получение локализованного label контакта
getLocalizedContactLabel(contactItem) {
    if (!contactItem) return '';
    
    const currentLanguage = this.currentLanguage || this.config.language || 'ru';
    
    // Проверяем многоязычную структуру
    if (contactItem.labels && typeof contactItem.labels === 'object') {
        return contactItem.labels[currentLanguage] || 
               contactItem.labels.ru || 
               contactItem.labels.en || 
               contactItem.label || 
               '';
    }
    
    // Fallback на старую структуру
    return contactItem.label || '';
}

    // Добавление контакта программно
    addContact(contact) {
        if (!this.config.contacts) {
            this.config.contacts = { enabled: true, title: 'Контакты', items: [] };
        }
        
        if (!this.config.contacts.items) {
            this.config.contacts.items = [];
        }
        
        this.config.contacts.items.push(contact);
        this.updateContactsDisplay();
        
        this.log('info', '📞 Добавлен контакт:', contact.type);
        return true;
    }

    // Удаление контакта по типу
    removeContact(type) {
        if (!this.config.contacts || !this.config.contacts.items) {
            return false;
        }
        
        const initialLength = this.config.contacts.items.length;
        this.config.contacts.items = this.config.contacts.items.filter(item => item.type !== type);
        
        if (this.config.contacts.items.length !== initialLength) {
            this.updateContactsDisplay();
            this.log('info', '📞 Удален контакт:', type);
            return true;
        }
        
        return false;
    }
    
    // ✅ НОВОЕ: Управление быстрыми кнопками
toggleQuickButtons() {
    // Переключаем состояние
    this.quickButtonsCollapsed = !this.quickButtonsCollapsed;
    
    const quickActions = this.widget.querySelector('.webchat-quick-actions');
    const toggleBtn = this.widget.querySelector('.webchat-quick-toggle-btn');
    
    if (quickActions && toggleBtn) {
        if (this.quickButtonsCollapsed) {
            quickActions.classList.add('webchat-quick-collapsed');
            toggleBtn.innerHTML = '▲';
            toggleBtn.title = this.texts.quickButtons?.toggleShow || 'Показать быстрые команды';
        } else {
            quickActions.classList.remove('webchat-quick-collapsed');
            toggleBtn.innerHTML = '▼';
            toggleBtn.title = this.texts.quickButtons?.toggleHide || 'Скрыть быстрые команды';
        }
    }
}

    // Программное управление быстрыми кнопками
    setQuickButtonsCollapsed(collapsed) {
        this.quickButtonsCollapsed = collapsed;
        
        const quickActions = this.widget.querySelector('.webchat-quick-actions');
        const toggleBtn = this.widget.querySelector('.webchat-quick-toggle-btn');
        
        if (quickActions && toggleBtn) {
            if (collapsed) {
                quickActions.classList.add('webchat-quick-collapsed');
                toggleBtn.innerHTML = '▲';
                toggleBtn.title = 'Показать быстрые команды';
            } else {
                quickActions.classList.remove('webchat-quick-collapsed');
                toggleBtn.innerHTML = '▼';
                toggleBtn.title = 'Скрыть быстрые команды';
            }
        }
        
        return true;
    }

    // Получение состояния быстрых кнопок
    getQuickButtonsState() {
        return {
            collapsed: this.quickButtonsCollapsed,
            enabled: this.config.behavior && this.config.behavior.showQuickButtons,
            total: this.config.getQuickButtons ? this.config.getQuickButtons().length : 0
        };
    }

// Получение информации о настройках голосовых сообщений
    getVoiceStorageInfo() {
        const voiceSettings = this.config.technical?.voiceSettings || {};
        return {
            serverStorageEnabled: voiceSettings.enableServerStorage || false,
            uploadEndpoint: voiceSettings.uploadEndpoint || '/upload-voice.php',
            maxSize: voiceSettings.maxVoiceSize || (5 * 1024 * 1024),
            format: voiceSettings.fileFormat || 'ogg',
            localFallback: voiceSettings.enableLocalFallback || false
        };
    }

    // Программное управление сохранением голосовых
    setVoiceServerStorage(enabled) {
        if (!this.config.technical) {
            this.config.technical = {};
        }
        if (!this.config.technical.voiceSettings) {
            this.config.technical.voiceSettings = {};
        }
        
        this.config.technical.voiceSettings.enableServerStorage = enabled;
        
        this.log('info', `🎤 Сохранение голосовых на сервер ${enabled ? 'ВКЛЮЧЕНО' : 'ОТКЛЮЧЕНО'}`);
        return true;
    }

// Фокус на поле ввода
    focusInput() {
        if (this.messageInput && !this.isMinimized) {
            this.messageInput.focus();
        }
    }

    // Автоизменение размера поля ввода
autoResizeInput() {
    if (this.messageInput) {
        // Сбрасываем высоту для правильного расчета
        this.messageInput.style.height = 'auto';
        
        // Определяем максимальную высоту в зависимости от устройства
        const maxHeight = this.isMobileDevice() ? 100 : 120;
        
        // Рассчитываем новую высоту
        const newHeight = Math.min(this.messageInput.scrollHeight, maxHeight);
        
        // Устанавливаем новую высоту
        this.messageInput.style.height = newHeight + 'px';
        
        // Для мобильных устройств - дополнительная прокрутка к концу
        if (this.isMobileDevice() && this.messageInput.scrollHeight > maxHeight) {
            this.messageInput.scrollTop = this.messageInput.scrollHeight;
        }
    }
}

    // ✅ НОВОЕ: Мобильная оптимизация
   // ✅ УЛУЧШЕННОЕ: Определение мобильного режима с разными порогами
isMobileDevice() {
    const userAgent = navigator.userAgent.toLowerCase();
    const mobileKeywords = ['android', 'iphone', 'ipad', 'ipod', 'blackberry', 'iemobile', 'opera mini'];
    const isMobileUA = mobileKeywords.some(keyword => userAgent.includes(keyword));
    
    // ⭐ РАЗНЫЕ ПОРОГИ: 480px для реальных мобильных, 768px для десктопа
    let widthThreshold = 768; // По умолчанию для десктопа
    
    if (isMobileUA) {
        // Для реальных мобильных устройств используем 480px
        widthThreshold = 480;
    }
    
    const isMobileScreen = window.innerWidth <= widthThreshold;
    
    return isMobileScreen;
}

// ✅ НОВЫЙ МЕТОД: Проверка изменения режима
checkModeChange() {
    const currentlyMobile = this.isMobileDevice();
    const wasInMobileMode = this.widget.classList.contains('webchat-mobile');
    
    if (currentlyMobile && !wasInMobileMode) {
        // Переключаемся В мобильный режим
        this.switchToMobileMode();
    } else if (!currentlyMobile && wasInMobileMode) {
        // Переключаемся ИЗ мобильного режима
        this.switchToDesktopMode();
    }
}

// ✅ НОВЫЙ МЕТОД: Переключение В мобильный режим
switchToMobileMode() {
    this.widget.classList.add('webchat-mobile');
    
    if (!this.isMinimized) {
        // Если чат развернут - применяем мобильные стили
        this.applyMobileFullscreen();
        this.manageMobileBodyScroll();
    }
    
    this.updateViewportHeight();
}

// ✅ НОВЫЙ МЕТОД: Переключение В десктопный режим  
// ✅ НОВЫЙ МЕТОД: Переключение В десктопный режим  
switchToDesktopMode() {
    this.widget.classList.remove('webchat-mobile');
    
    if (!this.isMinimized) {
        // Если чат развернут - применяем десктопные стили
        this.applyDesktopStyles();
        
        // Восстанавливаем прокрутку тела
        document.body.style.overflow = '';
        document.body.style.position = '';
        document.body.style.width = '';
        document.body.style.height = '';
    }
    
    // ✅ ИСПРАВЛЕНИЕ: Восстанавливаем закругления для шапки
    const header = this.widget.querySelector('.webchat-header');
    if (header) {
        // Удаляем inline стили, чтобы вернулись стили из CSS
        header.style.borderRadius = '';
    }
    
    // ✅ ДОПОЛНИТЕЛЬНО: Восстанавливаем закругления для всего виджета
    if (this.isMinimized) {
        this.widget.style.borderRadius = '';
    }
}

// ✅ НОВЫЙ МЕТОД: Применение десктопных стилей
applyDesktopStyles() {
    if (!this.widget) return;
    
    // Убираем мобильные стили
    this.widget.style.position = 'fixed';
    this.widget.style.top = '';
    this.widget.style.left = '';
    this.widget.style.right = '';
    this.widget.style.bottom = '';
    this.widget.style.width = '';
    this.widget.style.height = '';
    this.widget.style.maxWidth = '';
    this.widget.style.maxHeight = '';
    this.widget.style.borderRadius = '';
    this.widget.style.margin = '';
    this.widget.style.zIndex = '';
    
    // Применяем обычные настройки внешнего вида
    this.applyAppearanceSettings();
    
    // ✅ ДОБАВЬТЕ ЭТИ СТРОКИ В КОНЕЦ МЕТОДА:
    // Восстанавливаем закругления для внутренних элементов
    const header = this.widget.querySelector('.webchat-header');
    if (header) {
        header.style.borderRadius = '';
    }
    
    const inputArea = this.widget.querySelector('.webchat-input-area');
    if (inputArea) {
        inputArea.style.borderRadius = '';
    }
}

    // Адаптация интерфейса под мобильные
    adaptForMobile() {
    if (this.isMobileDevice()) {
        this.widget.classList.add('webchat-mobile');
        
        if (this.config.behavior) {
            this.config.behavior.autoFocus = false;
        }
        
        this.updateViewportHeight();
    }
}

    // ✅ НОВЫЕ ПУБЛИЧНЫЕ МЕТОДЫ ДЛЯ УПРАВЛЕНИЯ ПЕРЕКЛЮЧАТЕЛЕМ
    
    // Получение информации о переключателе
        getSwitcherInfo() {
        return {
        enabled: this.showConfigSwitcher,
        currentConfig: this.currentConfigName,
        availableConfigs: Object.keys(this.availableConfigs),
        totalAvailable: Object.keys(this.availableConfigs).length,
        // ✅ НОВОЕ: информация о теме
        theme: this.getThemeInfo()
     };
  }

    // Программное переключение конфигурации
    programmaticSwitchConfig(configName) {
        if (this.availableConfigs[configName]) {
            this.switchConfig(configName);
            return true;
        }
        return false;
    }

 // ✅ ЗДЕСЬ ДОБАВЛЯЕМ НОВЫЙ МЕТОД
    applyQuickButtonsState() {
        const quickActions = this.widget.querySelector('.webchat-quick-actions');
        if (!quickActions) {
            return;
        }
        
        if (this.quickButtonsCollapsed) {
            quickActions.classList.add('webchat-quick-collapsed');
        } else {
            quickActions.classList.remove('webchat-quick-collapsed');
        }
        
        // Обновляем иконку переключателя
        const toggleBtn = this.widget.querySelector('.webchat-quick-toggle-btn');
        if (toggleBtn) {
            toggleBtn.innerHTML = this.quickButtonsCollapsed ? '▲' : '▼';
            toggleBtn.title = this.quickButtonsCollapsed ? 
                (this.texts.quickButtons?.toggleShow || 'Показать быстрые команды') : 
                (this.texts.quickButtons?.toggleHide || 'Скрыть быстрые команды');
        }
    }
    
    // ✅ НОВЫЙ МЕТОД: Удаление сообщений о переключении языков
    clearLanguageSwitchingMessages() {
        if (!this.messagesContainer) return;
        
        // Удаляем ВСЕ старые сообщения с 🌍
        const allMessages = this.messagesContainer.querySelectorAll('.webchat-message');
        
        allMessages.forEach(message => {
            const content = message.querySelector('.webchat-message-content');
            if (content && content.innerHTML.includes('🌍')) {
                message.remove();
            }
        });
        
        // Очищаем из истории
        this.chatHistory = this.chatHistory.filter(msg => !msg.content.includes('🌍'));
        
        this.log('debug', '🗑️ Очищены старые сообщения о переключении языков');
    }
    
    // ✅ НОВЫЙ МЕТОД: Обновление всех времен при смене языка
updateAllMessageTimes() {
    try {
        // ✅ НОВОЕ: Принудительно обновляем тексты перед форматированием времени

        if (this.config.getTexts) {
            this.texts = this.config.getTexts();
        }
        
        // 1. Обновляем времена всех сообщений
        const timeElements = this.messagesContainer.querySelectorAll('.webchat-message-time');
        timeElements.forEach(timeElement => {
            const timestamp = timeElement.getAttribute('data-timestamp');
            if (timestamp) {
                // ✅ ИСПРАВЛЕНИЕ: Передаем текущий язык в formatMessageTime
                const newTimeText = this.formatMessageTime(timestamp, this.currentLanguage);
                timeElement.textContent = newTimeText;
            }
        });
        
        // 2. Обновляем заголовки дат
        const dateHeaders = this.messagesContainer.querySelectorAll('.webchat-date-header-content');
        dateHeaders.forEach(headerElement => {
            const timestamp = headerElement.getAttribute('data-timestamp');
            if (timestamp) {
                // ✅ ИСПРАВЛЕНИЕ: Передаем текущий язык в formatDateHeader
                const newDateText = this.formatDateHeader(new Date(timestamp), this.currentLanguage);
                headerElement.textContent = newDateText;
            }
        });
        
        // 3. Обновляем текст всплывающей подсказки если она показана
        if (this.scrollDateElement && this.scrollDateElement.textContent) {
            const timestamp = this.scrollDateElement.getAttribute('data-timestamp');
            if (timestamp) {
                // ✅ ИСПРАВЛЕНИЕ: Передаем текущий язык в formatDateHeader
                const newDateText = this.formatDateHeader(new Date(timestamp), this.currentLanguage);
                this.scrollDateElement.textContent = newDateText;
            }
        }
        
    } catch (error) {
        this.log('error','❌ Ошибка обновления времен:', error);
    }
}
    
    // ✅ НОВЫЙ МЕТОД: Восстановление состояния дата-системы
restoreScrollDateState(wasVisible, previousDateText) {
    
    if (!this.scrollDateElement) {
        return;
    }
    
    // Принудительно сбрасываем кэшированное состояние
    this.lastScrollDate = null;
    
    // Если подсказка была видна, обновляем её с новым языком
    if (wasVisible) {
        
        // Получаем актуальную дату для текущей позиции с новым языком
        const currentActualDate = this.getCurrentScrollDate();
        
        
        if (currentActualDate) {
            
            // Принудительно скрываем старую подсказку
            this.scrollDateElement.classList.remove('show');
            
            // Обновляем текст и показываем заново
            setTimeout(() => {
                this.scrollDateElement.textContent = currentActualDate;
                this.updateScrollDatePosition();
                this.scrollDateElement.classList.add('show');
                
            }, 100);
        }
    }
    
    // Сбрасываем состояние обработчика прокрутки
    this.resetScrollHandlerState();
}

// ✅ НОВЫЙ МЕТОД: Сброс состояния обработчика прокрутки
resetScrollHandlerState() {
    
    // Принудительно сбрасываем внутренние переменные через событие
    if (this.messagesContainer) {
        // Небольшой сдвиг прокрутки для сброса внутреннего состояния
        const currentScroll = this.messagesContainer.scrollTop;
        
        setTimeout(() => {
            // Микросдвиг для сброса состояния
            this.messagesContainer.scrollTop = currentScroll + 1;
            
            setTimeout(() => {
                this.messagesContainer.scrollTop = currentScroll;
            }, 50);
        }, 100);
    }
}

// ✅ ДОПОЛНИТЕЛЬНЫЙ МЕТОД: Принудительное обновление дата-системы
forceUpdateDateSystem() {
    // Сбрасываем все кэшированные состояния
    this.lastScrollDate = null;
    
    // Если подсказка видна - обновляем её
    if (this.scrollDateElement && this.scrollDateElement.classList.contains('show')) {
        const currentDate = this.getCurrentScrollDate();
        
        if (currentDate) {
            // Быстрое обновление без анимации
            this.scrollDateElement.textContent = currentDate;
            this.updateScrollDatePosition();
        }
    }
}
    
    // ✅ ПРОСТОЙ МЕТОД: Удаление только сообщений о переключении
clearSwitchingMessages() {
    if (!this.messagesContainer) return;
    
    // Просто удаляем ВСЕ старые сообщения с 🔄
    const allMessages = this.messagesContainer.querySelectorAll('.webchat-message');
    
    allMessages.forEach(message => {
        const content = message.querySelector('.webchat-message-content');
        if (content && content.innerHTML.includes('🔄')) {
            message.remove();
        }
    });
    
    // Очищаем из истории
    this.chatHistory = this.chatHistory.filter(msg => !msg.content.includes('🔄'));
    
    this.log('debug', '🗑️ Очищены старые сообщения о переключении');
}

// ✅ ПРОСТАЯ И НАДЕЖНАЯ ОЧИСТКА: Только по первой строке из конфигов
clearWelcomeMessages() {
    if (!this.messagesContainer) return;
    
    let removedMessages = 0;
    // Получаем все первые строки из конфигов
    const welcomeFirstLines = this.extractWelcomeFirstLines();
    // Ищем сообщения бота
    const allBotMessages = this.messagesContainer.querySelectorAll('.webchat-message.webchat-bot');
    
    allBotMessages.forEach((message, index) => {
        const content = message.querySelector('.webchat-message-content');
        if (content) {
            const messageHTML = content.innerHTML;
            
            // Проверяем точное совпадение с первой строкой
            const matchesWelcomeLine = welcomeFirstLines.some(line => {
                const isMatch = messageHTML.includes(line);
                if (isMatch) {
                }
                return isMatch;
            });
            
            if (matchesWelcomeLine) {
                message.remove();
                removedMessages++;
            }
        }
    });
    
    // Очищаем из истории чата
    const originalLength = this.chatHistory.length;
    this.chatHistory = this.chatHistory.filter(msg => {
        if (msg.type === 'bot') {
            return !welcomeFirstLines.some(line => msg.content.includes(line));
        }
        return true;
    });
    
    const removedFromHistory = originalLength - this.chatHistory.length;
}

// ✅ ПРОСТОЙ МЕТОД: Извлечение только первых строк приветствий
extractWelcomeFirstLines() {
    // ✅ КЭШИРОВАНИЕ: Если данные уже извлечены, используем их
    if (this.cachedWelcomeLines) {
        return this.cachedWelcomeLines;
    }

    const welcomeFirstLines = [];
    
    try {
        const availableConfigs = this.getAvailableConfigs();
        
        Object.values(availableConfigs).forEach(config => {
            // Собираем данные из текстов всех языков
            if (config.texts) {
                Object.values(config.texts).forEach(langTexts => {
                    if (langTexts.welcomeMessage) {
                        // Извлекаем первую строку с <strong>
                        const strongMatch = langTexts.welcomeMessage.match(/<strong>(.*?)<\/strong>/i);
                        if (strongMatch) {
                            const fullFirstLine = strongMatch[0]; // полная строка с тегами
                            welcomeFirstLines.push(fullFirstLine);
                        }
                    }
                });
            }
        });
        
        // Добавляем данные текущей конфигурации если её нет в списке
        if (this.config && this.config.texts) {
            Object.values(this.config.texts).forEach(langTexts => {
                if (langTexts.welcomeMessage) {
                    const strongMatch = langTexts.welcomeMessage.match(/<strong>(.*?)<\/strong>/i);
                    if (strongMatch) {
                        const fullFirstLine = strongMatch[0];
                        if (!welcomeFirstLines.includes(fullFirstLine)) {
                            welcomeFirstLines.push(fullFirstLine);
                        }
                    }
                }
            });
        }
        
    } catch (error) {
        this.log('error','❌ Ошибка извлечения первых строк:', error);
    }
    
    // ✅ КЭШИРУЕМ результат
    this.cachedWelcomeLines = welcomeFirstLines;
  
    return welcomeFirstLines;
}

// ✅ УЛУЧШЕННЫЙ МЕТОД: Очистка дублирующихся заголовков дат
clearDuplicateDateHeaders() {
    if (!this.messagesContainer) return;
    
    const dateHeaders = this.messagesContainer.querySelectorAll('.webchat-date-header');
    let removedHeaders = 0;
    let seenDates = new Set();
  
    dateHeaders.forEach((header, index) => {
        const content = header.querySelector('.webchat-date-header-content');
        if (content) {
            const currentText = content.textContent.trim();
            
            // Если уже видели такую дату - удаляем
            if (seenDates.has(currentText)) {
                header.remove();
                removedHeaders++;
            } else {
                seenDates.add(currentText);
            }
        }
    });
    
    if (removedHeaders > 0) {
    } else {
  }
}

    // ✅ НОВЫЕ API МЕТОДЫ ДЛЯ УПРАВЛЕНИЯ ЯЗЫКАМИ

    // Получение текущего языка
    getCurrentLanguage() {
        return this.currentLanguage;
    }

    // Получение поддерживаемых языков
    getAvailableLanguages() {
        return this.getSupportedLanguages();
    }

    // Программное переключение языка (для вызова с сайта)
    setLanguage(language) {
        return this.switchLanguage(language);
    }

    // Получение информации о языках
    getLanguageInfo() {
        return {
            current: this.currentLanguage,
            supported: this.getSupportedLanguages(),
            switcherEnabled: this.showLanguageSwitcher,
            autoDetect: window.GlobalConfigSettings && window.GlobalConfigSettings.languageSettings ? 
                       window.GlobalConfigSettings.languageSettings.autoDetectLanguage : false
        };
    }

    // Программное включение/отключение переключателя языков
    setLanguageSwitcherEnabled(enabled) {
        if (window.GlobalConfigSettings && window.GlobalConfigSettings.languageSettings) {
            window.GlobalConfigSettings.languageSettings.showLanguageSwitcher = enabled;
            
            // Обновляем локальные настройки
            this.showLanguageSwitcher = this.shouldShowLanguageSwitcher();
            
            // Перерисовываем интерфейс
            this.updateLanguageSwitcherDisplay();
            
            this.log('info', `🌍 Переключатель языков ${enabled ? 'ВКЛЮЧЕН' : 'ОТКЛЮЧЕН'}`);
        }
    }

    // ✅ ИСПРАВЛЕННЫЙ МЕТОД: Обновление отображения переключателя языков
updateLanguageSwitcherDisplay() {
    this.log('debug', '🔄 Обновление отображения переключателя языков');
    
    // Ищем переключатель в шапке
    let languageDropdown = this.widget.querySelector('.webchat-language-dropdown');
    
    if (this.shouldShowLanguageSwitcher()) {
        // Нужно показать переключатель
        this.log('debug', '✅ Переключатель языков должен быть показан');
        
        if (!languageDropdown) {
            // Создаем переключатель в шапке
            this.log('info', '🔧 Создаем переключатель языков в шапке');
            const headerDiv = this.widget.querySelector('.webchat-header');
            const minimizeBtn = this.widget.querySelector('.webchat-minimize-btn');
            
            if (headerDiv && minimizeBtn) {
                const languageSwitcherHTML = this.generateLanguageSwitcherHTML();
                if (languageSwitcherHTML && languageSwitcherHTML.trim()) {
                    minimizeBtn.insertAdjacentHTML('beforebegin', languageSwitcherHTML);
                    languageDropdown = this.widget.querySelector('.webchat-language-dropdown');
                }
            }
        } else {
            // Обновляем существующий переключатель
            const languageSwitcherHTML = this.generateLanguageSwitcherHTML();
            if (languageSwitcherHTML && languageSwitcherHTML.trim()) {
                languageDropdown.outerHTML = languageSwitcherHTML;
                languageDropdown = this.widget.querySelector('.webchat-language-dropdown');
            }
        }
        
        if (languageDropdown) {
            // Управляем видимостью в зависимости от состояния чата
            if (this.isMinimized) {
                languageDropdown.style.display = 'none';
            } else {
                languageDropdown.style.display = 'flex';
            }
            
            this.log('info', '🌍 Переключатель языков обновлен в шапке');
            
            // Обновляем состояние кнопок
            this.updateLanguageButtons();
        }
    } else {
        // Не нужно показывать переключатель
        this.log('debug', '🚫 Переключатель языков не нужен');
        
        if (languageDropdown) {
            // Удаляем переключатель если он есть
            languageDropdown.remove();
            this.log('info', '🗑️ Переключатель языков удален (отключен)');
        }
    }
}
    
    // Уничтожение чата
    destroy() {
    // ✅ НОВОЕ: Очищаем обработчик изменения размера
    if (this.resizeHandler) {
        window.removeEventListener('resize', this.resizeHandler);
        this.resizeHandler = null;
    }
    
    // ✅ НОВОЕ: Восстанавливаем прокрутку при уничтожении чата
    if (this.isMobileDevice()) {
        // Удаляем обработчики ориентации
        window.removeEventListener('orientationchange', this.handleOrientationChange);
        window.removeEventListener('resize', this.handleOrientationChange);
        document.body.style.overflow = '';
        document.body.style.position = '';
        document.body.style.width = '';
    }
    
    // Отключаем отслеживание системной темы
    this.disableSystemThemeTracking();
    if (this.widget && this.widget.parentNode) {
        this.widget.parentNode.removeChild(this.widget);
    }
    
    if (this.mediaRecorder && this.isRecording) {
        this.mediaRecorder.stop();
        this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }
    
   // ✅ ИСПРАВЛЕНИЕ: Очищаем обработчики файлов
    this.removeFileHandlers();
    
    // Очистка ссылок
    // ✅ НОВОЕ: Очищаем обработчики времени
    this.cleanupScrollDateHandlers();
    this.widget = null;
    this.messagesContainer = null;
    this.messageInput = null;
    this.statusIndicator = null;
    this.typingIndicator = null;
    this.configSelect = null;
    this.fileInput = null;
    this.filePreview = null;
    this.fileUploadingIndicator = null;
    
    // ✅ НОВОЕ: Останавливаем мониторинг
this.stopMonitoring();
    this.log('info', '🗑️ Web chat destroyed');;
    }
    
    // ===============================================
    // ✅ НОВЫЕ МЕТОДЫ ДЛЯ РАБОТЫ С ФАЙЛАМИ
    // ===============================================
    // Настройка обработчиков файлов
    setupFileHandlers() {
        // Если область ввода скрыта, не настраиваем обработчики
    if (this.config.behavior && this.config.behavior.showInputArea === false) {
        this.log('info', 'ℹ️ Область ввода скрыта, обработчики файлов не настраиваются');
        return;
    }
    
    if (!this.fileInput) {
        this.log('warn', '⚠️ fileInput не найден при инициализации обработчиков');
        return;
    }
        if (!this.fileInput) {
            this.log('warn', '⚠️ fileInput не найден при инициализации обработчиков');
            return;
        }
        
        // ✅ ИСПРАВЛЕНИЕ: Удаляем старые обработчики перед добавлением новых
        this.removeFileHandlers();
        
        // Обработчик выбора файла
        this.fileChangeHandler = (e) => {
            const file = e.target.files[0];
            if (file) {
                this.handleSelectedFile(file);
            }
        };
        this.fileInput.addEventListener('change', this.fileChangeHandler);
        
        // Обработчик вставки изображений (Ctrl+V)
        if (this.fileSettings.enablePasteImages && this.messageInput) {
            this.pasteHandler = (e) => {
                this.handlePaste(e);
            };
            this.messageInput.addEventListener('paste', this.pasteHandler);
        }
        
        // Обработчик drag & drop
        if (this.fileSettings.enableFileUpload) {
            this.setupDragAndDrop();
        }
        
        this.log('debug', '🔧 Обработчики файлов настроены');
    }
    
    // ✅ НОВЫЙ МЕТОД: Удаление старых обработчиков
    removeFileHandlers() {
        if (this.fileInput && this.fileChangeHandler) {
            this.fileInput.removeEventListener('change', this.fileChangeHandler);
        }
        
        if (this.messageInput && this.pasteHandler) {
            this.messageInput.removeEventListener('paste', this.pasteHandler);
        }
        
        if (this.dragOverHandler) {
            this.widget.removeEventListener('dragover', this.dragOverHandler);
        }
        
        if (this.dragLeaveHandler) {
            this.widget.removeEventListener('dragleave', this.dragLeaveHandler);
        }
        
        if (this.dropHandler) {
            this.widget.removeEventListener('drop', this.dropHandler);
        }
    }
    
    // Обработка вставки (Ctrl+V)
    handlePaste(e) {
        const items = e.clipboardData?.items;
        if (!items) return;
        
        for (let item of items) {
            if (item.type.indexOf('image') !== -1) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) {
                    this.handleSelectedFile(file);
                }
                break;
            }
        }
    }
    
    // Настройка drag & drop
    // Настройка drag & drop
    setupDragAndDrop() {
        if (!this.widget) return;
        
        // ✅ ИСПРАВЛЕНИЕ: Сохраняем ссылки на обработчики для последующего удаления
        this.dragOverHandler = (e) => {
            e.preventDefault();
            this.widget.classList.add('webchat-dragover');
        };
        
        this.dragLeaveHandler = (e) => {
            e.preventDefault();
            this.widget.classList.remove('webchat-dragover');
        };
        
        this.dropHandler = (e) => {
            e.preventDefault();
            this.widget.classList.remove('webchat-dragover');
            
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                this.handleSelectedFile(files[0]);
            }
        };
        
        this.widget.addEventListener('dragover', this.dragOverHandler);
        this.widget.addEventListener('dragleave', this.dragLeaveHandler);
        this.widget.addEventListener('drop', this.dropHandler);
    }
    
    // Открытие диалога выбора файла
    selectFile() {
        if (this.fileInput) {
            this.fileInput.click();
        }
    }
    
    // Обработка выбранного файла
    handleSelectedFile(file) {
        // Проверка размера файла
        if (file.size > this.fileSettings.maxFileSize) {
            this.showError(this.texts.interface.fileTooLarge + ` (максимум ${this.formatFileSize(this.fileSettings.maxFileSize)})`);
            return;
        }
        
        // Проверка типа файла
        if (!this.fileSettings.allowedTypes.includes(file.type)) {
            this.showError(this.texts.interface.fileTypeNotAllowed);
            return;
        }
        
        this.currentFile = file;
        this.showFilePreview(file);
        
        this.log('info', '📎 Файл выбран:', {
    name: file.name,
    size: this.formatFileSize(file.size),
    sizeBytes: file.size,
    type: file.type,
    maxAllowed: this.formatFileSize(this.fileSettings.maxFileSize),
    maxAllowedBytes: this.fileSettings.maxFileSize
});
    }
    
    // Показ превью файла
    showFilePreview(file) {
    if (!this.filePreview) return;
    
    const previewContent = document.getElementById('webchatFilePreviewContent');
    if (!previewContent) return;
    
    // ✅ НОВОЕ: Обновляем тексты в заголовке preview
    const filePreviewLabel = this.widget.querySelector('.webchat-file-preview-label');
    if (filePreviewLabel) {
        filePreviewLabel.textContent = this.texts.interface?.selectedFile || 'Выбранный файл:';
    }
    
    const filePreviewCloseBtn = this.widget.querySelector('.webchat-file-preview-close');
    if (filePreviewCloseBtn) {
        filePreviewCloseBtn.title = this.texts.interface?.removeFile || 'Убрать файл';
    }
    
    const isImage = file.type.startsWith('image/');

    // ✅ ИСПРАВЛЕНИЕ УТЕЧКИ ПАМЯТИ: Освобождаем предыдущий URL если есть
    if (this.currentPreviewImageUrl) {
        URL.revokeObjectURL(this.currentPreviewImageUrl);
        this.currentPreviewImageUrl = null;
    }

    let previewHTML = '';

    if (isImage) {
        const imageUrl = URL.createObjectURL(file);
        this.currentPreviewImageUrl = imageUrl; // ✅ Сохраняем для последующего освобождения
        previewHTML = `
            <img src="${imageUrl}" class="webchat-file-preview-image" alt="Предварительный просмотр">
            <div class="webchat-file-preview-info">
                <div class="webchat-file-preview-name">${this.escapeHTML(file.name)}</div>
                <div class="webchat-file-preview-size">${this.formatFileSize(file.size)}</div>
            </div>
        `;
    } else {
        const fileIcon = this.getFileIcon(file.type);
        previewHTML = `
            <div class="webchat-file-preview-icon">${fileIcon}</div>
            <div class="webchat-file-preview-info">
                <div class="webchat-file-preview-name">${this.escapeHTML(file.name)}</div>
                <div class="webchat-file-preview-size">${this.formatFileSize(file.size)}</div>
            </div>
        `;
    }
    
    previewContent.innerHTML = previewHTML;
    this.filePreview.classList.add('show');
}
    
    // Получение иконки для типа файла
    getFileIcon(fileType) {
        const iconMap = {
            'application/pdf': '📄',
            'text/plain': '📝',
            'text/csv': '📊',
            'application/msword': '📝',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '📝',
            'application/vnd.ms-excel': '📊',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '📊'
        };
        
        return iconMap[fileType] || '📎';
    }

    // ✅ УДАЛЕНО ДУБЛИРОВАНИЕ: blobToBase64 и base64ToBlob уже определены выше (строки 3778-3919)

    // ✅ НОВЫЙ МЕТОД: Создание голосового плеера (вынесен отдельно для переиспользования)
createVoicePlayer(audioBlob) {
    const audioContainer = document.createElement('div');
    audioContainer.className = 'webchat-audio-message';
    
    // Скрытый audio элемент
    const audio = document.createElement('audio');
    audio.src = URL.createObjectURL(audioBlob);
    audio.preload = 'metadata';
    
    // Кнопка воспроизведения
    const playBtn = document.createElement('button');
    playBtn.className = 'webchat-voice-play-btn';
    playBtn.innerHTML = `
        <span class="play-icon">▶</span>
        <span class="pause-icon">⏸</span>
    `;
    
    // Контейнер для волн и информации
    const contentContainer = document.createElement('div');
    contentContainer.className = 'webchat-voice-content';
    
    // Волновая анимация
    const waveform = document.createElement('div');
    waveform.className = 'webchat-voice-waveform';
    
    // Создаем волны (случайной высоты) с использованием DocumentFragment для оптимизации
    const waveCount = 30;
    const waves = [];
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < waveCount; i++) {
        const wave = document.createElement('div');
        wave.className = 'webchat-voice-wave';
        wave.style.height = Math.random() * 16 + 4 + 'px';
        fragment.appendChild(wave);
        waves.push(wave);
    }
    waveform.appendChild(fragment);
    
    // Прогресс бар
    const progressContainer = document.createElement('div');
    progressContainer.className = 'webchat-voice-progress';
    const progressBar = document.createElement('div');
    progressBar.className = 'webchat-voice-progress-bar';
    progressContainer.appendChild(progressBar);
    
    // Информация о времени и размере
    const infoContainer = document.createElement('div');
    infoContainer.className = 'webchat-voice-info';
    
    const timeDisplay = document.createElement('span');
    timeDisplay.className = 'webchat-voice-time';
    timeDisplay.textContent = '0:00';
    
    const sizeDisplay = document.createElement('span');
    sizeDisplay.className = 'webchat-voice-size';
    sizeDisplay.textContent = this.formatFileSize(audioBlob.size);
    
    infoContainer.appendChild(timeDisplay);
    infoContainer.appendChild(sizeDisplay);
    
    // Собираем контент
    contentContainer.appendChild(waveform);
    contentContainer.appendChild(progressContainer);
    contentContainer.appendChild(infoContainer);
    
    audioContainer.appendChild(playBtn);
    audioContainer.appendChild(contentContainer);
    audioContainer.appendChild(audio); // скрытый
    
    // ✅ ДОБАВЛЯЕМ ВСЮ ЛОГИКУ ВОСПРОИЗВЕДЕНИЯ
    this.setupVoicePlayerLogic(audio, playBtn, waves, progressBar, timeDisplay);
    
    return audioContainer;
}

// ✅ НОВЫЙ МЕТОД: Логика воспроизведения (вынесена отдельно)
setupVoicePlayerLogic(audio, playBtn, waves, progressBar, timeDisplay) {
    let isPlaying = false;
    let animationInterval = null;
    let progressInterval = null;

    // ✅ ИСПРАВЛЕНИЕ УТЕЧКИ ПАМЯТИ: Функция очистки ресурсов
    const cleanup = () => {
        if (animationInterval) {
            clearInterval(animationInterval);
            animationInterval = null;
        }
        if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
        }

        // Освобождаем URL объект
        if (audio.src && audio.src.startsWith('blob:')) {
            URL.revokeObjectURL(audio.src);
        }
    };

    // ✅ Отслеживаем удаление элемента из DOM
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.removedNodes.forEach((node) => {
                if (node.contains && node.contains(audio)) {
                    cleanup();
                    observer.disconnect();
                }
            });
        });
    });

    // Наблюдаем за родительским контейнером
    if (audio.parentNode) {
        observer.observe(audio.parentNode, { childList: true, subtree: true });
    }

    // Обновление времени
    const formatTime = (seconds) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };
    
    // Анимация волн
    const animateWaves = (progress = 0) => {
        waves.forEach((wave, index) => {
            const delay = index * 100;
            const shouldAnimate = (Date.now() + delay) % 1600 < 800;
            
            if (shouldAnimate) {
                wave.classList.add('animating', 'active');
            } else {
                wave.classList.remove('animating', 'active');
            }
            
            // Показываем прогресс
            if (index / waves.length <= progress) {
                wave.classList.add('active');
            } else if (!shouldAnimate) {
                wave.classList.remove('active');
            }
        });
    };
    
    // Обработчик загрузки метаданных
    audio.addEventListener('loadedmetadata', () => {
        const duration = audio.duration;
        if (!isNaN(duration)) {
            timeDisplay.textContent = formatTime(duration);
        }
    });
    
    // Обработчик воспроизведения
    playBtn.addEventListener('click', () => {
        if (isPlaying) {
            // Пауза
            audio.pause();
            playBtn.classList.remove('playing');
            isPlaying = false;
            
            // Останавливаем анимации
            if (animationInterval) {
                clearInterval(animationInterval);
                animationInterval = null;
            }
            if (progressInterval) {
                clearInterval(progressInterval);
                progressInterval = null;
            }
            
            waves.forEach(wave => {
                wave.classList.remove('animating');
            });
            
        } else {
            // Воспроизведение
            audio.play().then(() => {
                playBtn.classList.add('playing');
                isPlaying = true;
                
                // Запускаем анимацию волн
                animationInterval = setInterval(() => {
                    const progress = audio.currentTime / audio.duration;
                    animateWaves(progress);
                }, 100);
                
                // Обновляем прогресс
                progressInterval = setInterval(() => {
                    if (audio.duration) {
                        const progress = (audio.currentTime / audio.duration) * 100;
                        progressBar.style.width = progress + '%';
                        timeDisplay.textContent = formatTime(audio.currentTime);
                    }
                }, 100);
                
            }).catch(error => {
                this.log('error','❌ Ошибка воспроизведения:', error);
                playBtn.classList.remove('playing');
                isPlaying = false;
            });
        }
    });
    
    // Обработчик окончания воспроизведения
    audio.addEventListener('ended', () => {
        playBtn.classList.remove('playing');
        isPlaying = false;
        progressBar.style.width = '0%';
        
        if (animationInterval) {
            clearInterval(animationInterval);
            animationInterval = null;
        }
        if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
        }
        
        waves.forEach(wave => {
            wave.classList.remove('animating', 'active');
        });
        
        // Сбрасываем время
        if (audio.duration) {
            timeDisplay.textContent = formatTime(audio.duration);
        }
    });
}

// Восстановление сообщения из истории (с поддержкой голосовых и видео)
async restoreMessageFromHistory(msg) {
    // Отладка восстановления
    if (msg.type === 'voice') {
        this.log('debug', '🎤 Восстанавливаем голосовое сообщение');
    }
    
    if (msg.type === 'video') {
        this.log('debug', '🎥 Восстанавливаем видеосообщение');
    }
    
    // ✅ НОВОЕ: Проверяем нужно ли добавить заголовок даты
    const previousMsg = this.chatHistory[this.chatHistory.indexOf(msg) - 1];
    if (this.shouldShowDateHeader(msg.timestamp, previousMsg?.timestamp)) {
        this.addDateHeader(msg.timestamp);
    }
    
    // ✅ ОБРАБОТКА ГОЛОСОВЫХ СООБЩЕНИЙ
    if (msg.type === 'voice' && msg.voiceUrl) {
        const voiceSettings = this.config.technical?.voiceSettings || {};
        
        if (voiceSettings.enableServerStorage) {
            try {
                const audioBlob = await this.downloadVoiceFromServer(msg.voiceUrl);
                if (audioBlob) {
                    await this.addVoiceMessageFromHistory(audioBlob, msg.content);
                    
                    const lastMessage = this.messagesContainer.lastElementChild;
                    if (lastMessage && lastMessage.classList.contains('webchat-voice-message') && msg.timestamp) {
                        this.addTimeToMessage(lastMessage, msg.timestamp);
                    }
                    
                    this.log('info', '✅ Голосовое сообщение восстановлено');
                } else {
                    this.addMessageToUI(
                        this.texts.system.voiceMessageUnavailable || '🎤 Voice message (unavailable)', 
                        msg.type, 
                        msg.timestamp
                    );
                }
            } catch (error) {
                this.log('error', '❌ Ошибка восстановления голосового сообщения:', error);
                this.addMessageToUI(
                    this.texts.system.voiceMessageError || '🎤 Voice message (loading error)', 
                    msg.type, 
                    msg.timestamp
                );
            }
        } else {
            this.addMessageToUI(
                this.texts.system.voiceMessage || '🎤 Voice message', 
                msg.type, 
                msg.timestamp
            );
        }
    } else if (msg.type === 'voice' && !msg.voiceUrl) {
        const fallbackText = msg.content || this.texts.system.voiceMessage || '🎤 Voice message';
        this.addMessageToUI(fallbackText, msg.type, msg.timestamp);
    }
    // ✅ НОВОЕ: ОБРАБОТКА ВИДЕОСООБЩЕНИЙ
    else if (msg.type === 'video' && msg.videoUrl) {
    try {
        const videoData = {
            url: msg.videoUrl,
            duration: msg.videoDuration || 0,
            thumbnail: msg.thumbnail || null
        };
        
        await this.addVideoMessageFromHistory(videoData, msg.content);
        
        // Добавляем время к восстановленному видео
        const lastMessage = this.messagesContainer.lastElementChild;
        if (lastMessage && lastMessage.classList.contains('webchat-video-message') && msg.timestamp) {
            this.addTimeToMessage(lastMessage, msg.timestamp);
        }
        
        this.log('info', '✅ Видеосообщение восстановлено из истории');
        
    } catch (error) {
        this.log('error', '❌ Ошибка восстановления видеосообщения:', error);
        this.addMessageToUI(
            this.texts.system?.videoMessageError || '🎥 Video message (loading error)', 
            msg.type, 
            msg.timestamp
        );
    }
} else if (msg.type === 'video' && !msg.videoUrl) {
    const fallbackText = msg.content || this.texts.system?.videoMessage || '🎥 Video message';
    this.addMessageToUI(fallbackText, msg.type, msg.timestamp);
}
    // ✅ НОВОЕ: ОБРАБОТКА ФАЙЛОВ
    else if (msg.file && msg.file.data) {
        // Восстанавливаем сообщение с файлом
        this.addFileMessageFromHistory(msg.content, msg.file, msg.type, msg.timestamp);
        this.log('info', '✅ Файл восстановлен из истории:', msg.file.name);
    }
    // ✅ ОБЫЧНОЕ ТЕКСТОВОЕ СООБЩЕНИЕ
    else {
        this.addMessageToUI(msg.content, msg.type, msg.timestamp);
    }
}

// ✅ НОВЫЙ МЕТОД: Добавление голосового сообщения из истории (БЕЗ повторного сохранения)
async addVoiceMessageFromHistory(audioBlob, text) {

    // ✅ СОЗДАЕМ ТОТ ЖЕ UI КАК В addVoiceMessage(), НО БЕЗ СОХРАНЕНИЯ В ИСТОРИЮ
    const messageDiv = document.createElement('div');
    messageDiv.className = 'webchat-message webchat-bot webchat-voice-message';
    
    const avatar = document.createElement('div');
    avatar.className = 'webchat-message-avatar webchat-bot-avatar';
    avatar.textContent = this.config.botInfo.avatar;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'webchat-message-content webchat-voice-content-wrapper';
    contentDiv.style.background = 'transparent';
    contentDiv.style.border = 'none';
    contentDiv.style.padding = '0';
    contentDiv.style.boxShadow = 'none';
    contentDiv.style.borderRadius = '0';
    
    // ✅ СОЗДАЕМ ГОЛОСОВОЙ ПЛЕЕР (переиспользуем метод)
    const audioContainer = this.createVoicePlayer(audioBlob);
    contentDiv.appendChild(audioContainer);
    
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    this.messagesContainer.appendChild(messageDiv);

}
    
// ==============================================
// ✅ СИСТЕМА ВРЕМЕНИ И ДАТ (КАК В TELEGRAM)
// ==============================================

// Форматирование времени сообщения (HH:MM или HH:MM AM/PM)
formatMessageTime(timestamp, language = null) {
    try {
        const lang = language || this.currentLanguage || this.config.language || 'ru';
        const date = new Date(timestamp);
        
        if (isNaN(date.getTime())) {
            return '';
        }
        
        // ✅ ПОЛУЧАЕМ АКТУАЛЬНЫЕ ТЕКСТЫ для времени (аналогично formatDateHeader)
        let timeTexts = null;
        
        // 1. Получаем тексты НАПРЯМУЮ из конфига для указанного языка
        if (this.config.getTexts) {
            try {
                const originalLang = this.config.language;
                this.config.language = lang;
                
                const freshTexts = this.config.getTexts();
                timeTexts = freshTexts.datetime;
                
                this.config.language = originalLang;
            } catch (error) {
                this.log('error','❌ Ошибка получения свежих текстов для времени:', error);
            }
        }
        
        // Fallback к базовым текстам
        if (!timeTexts && typeof baseInterfaceTexts !== 'undefined' && baseInterfaceTexts[lang]) {
            timeTexts = baseInterfaceTexts[lang].datetime;
        }
        
        // Получаем настройки формата времени
        const timeFormat = timeTexts?.timeFormat || (lang === 'en' ? '12h' : '24h');
        
        if (timeFormat === '12h') {
            // 12-часовой формат (для английского)
            let hours = date.getHours();
            const minutes = date.getMinutes();
            const ampm = hours >= 12 ? (timeTexts?.ampm?.pm || 'PM') : (timeTexts?.ampm?.am || 'AM');
            
            hours = hours % 12;
            hours = hours ? hours : 12; // 0 часов = 12
            
            const result = `${hours}:${minutes.toString().padStart(2, '0')} ${ampm}`;
            return result;
        } else {
            // 24-часовой формат (для русского и др.)
            const hours = date.getHours();
            const minutes = date.getMinutes();
            const result = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
            return result;
        }
    } catch (error) {
        this.log('error','❌ Ошибка форматирования времени:', error);
        return '';
    }
}

// Форматирование заголовка даты
formatDateHeader(date, language = null) {
    try {
        const lang = language || this.currentLanguage || this.config.language || 'ru';
   
        // ✅ ПОЛУЧАЕМ АКТУАЛЬНЫЕ ТЕКСТЫ НАПРЯМУЮ (не из this.texts!)
        let dateTexts = null;
        
        // 1. ✅ НОВОЕ: Получаем тексты НАПРЯМУЮ из конфига для указанного языка
        if (this.config.getTexts) {
            try {
                // Временно меняем язык для получения правильных текстов
                const originalLang = this.config.language;
                this.config.language = lang;
                
                const freshTexts = this.config.getTexts();
                dateTexts = freshTexts.datetime;
                
                // Восстанавливаем язык
                this.config.language = originalLang;

            } catch (error) {
                this.log('error','❌ Ошибка получения свежих текстов:', error);
            }
        }
        
        // 2. Fallback: пытаемся из this.texts (может быть устаревшим)
        if (!dateTexts && this.texts && this.texts.datetime) {
            dateTexts = this.texts.datetime;
        }
        
        // 3. Fallback: пытаемся из config.texts напрямую
        if (!dateTexts && this.config.texts && this.config.texts[lang] && this.config.texts[lang].datetime) {
            dateTexts = this.config.texts[lang].datetime;
        }
        
        // 4. ✅ НОВОЕ: Пытаемся из глобального baseInterfaceTexts
        if (!dateTexts && typeof baseInterfaceTexts !== 'undefined' && baseInterfaceTexts[lang] && baseInterfaceTexts[lang].datetime) {
            dateTexts = baseInterfaceTexts[lang].datetime;
        }
        
        // 5. Критический fallback
        if (!dateTexts) {
            this.log('error','❌ НЕ НАЙДЕНЫ тексты datetime для языка:', lang);
            
            if (lang === 'en') {
                dateTexts = { today: "Today", yesterday: "Yesterday", monthsFull: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] };
            } else {
                dateTexts = { today: "Сегодня", yesterday: "Вчера", monthsFull: ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"] };
            }
        }
        
        // ✅ ИСПРАВЛЕНИЕ: правильно создаем даты для сравнения
        const messageDate = new Date(date);
        const today = new Date();
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        
        // ✅ ИСПРАВЛЕНИЕ: сравниваем только даты без времени
        const messageDateOnly = new Date(messageDate.getFullYear(), messageDate.getMonth(), messageDate.getDate());
        const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const yesterdayOnly = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());
        
        // Сравниваем времена (миллисекунды)
        if (messageDateOnly.getTime() === todayOnly.getTime()) {
            const result = dateTexts.today;
            return result;
        } else if (messageDateOnly.getTime() === yesterdayOnly.getTime()) {
            const result = dateTexts.yesterday;
            return result;
        } else {
            // Формат: "15 января" или "15 January"
            const day = messageDate.getDate();
            const monthIndex = messageDate.getMonth();
            const year = messageDate.getFullYear();
            const currentYear = today.getFullYear();
            
            const monthName = dateTexts?.monthsFull?.[monthIndex] || 
                             dateTexts?.months?.[monthIndex] || 
                             String(monthIndex + 1);
            
            let result;
            if (year === currentYear) {
                // Текущий год - не показываем год
                result = `${day} ${monthName}`;
            } else {
                // Другой год - показываем год
                result = `${day} ${monthName} ${year}`;
            }
            
            return result;
        }
    } catch (error) {
        this.log('error','❌ Ошибка форматирования заголовка даты:', error);
        return this.texts.errors?.dateError || 'Date error';
    }
}

// ✅ НОВЫЙ МЕТОД: Получение текущей даты для позиции прокрутки
getCurrentScrollDate() {
    try {
        // ✅ НОВОЕ: Принудительная проверка актуальности DOM
        if (!this.messagesContainer) {
            return null;
        }
        
        const messages = this.messagesContainer.querySelectorAll('.webchat-message');
        const historyLength = this.chatHistory ? this.chatHistory.length : 0;
        
        if (messages.length === 0 || historyLength === 0) {
            return null;
        }
        
        // ✅ НОВОЕ: Используем актуальные размеры контейнера
        const scrollTop = this.messagesContainer.scrollTop;
        const scrollHeight = this.messagesContainer.scrollHeight;
        const clientHeight = this.messagesContainer.clientHeight;
        
        // Проверяем что не в самом низу
        const isNearBottom = scrollTop >= (scrollHeight - clientHeight - 50);
        if (isNearBottom) {
            // Если в самом низу - возвращаем дату последнего сообщения
            const historyMessages = this.chatHistory.filter(msg => 
                msg.type === 'user' || msg.type === 'bot' || msg.type === 'voice'
            );
            
            if (historyMessages.length > 0) {
                const lastMessage = historyMessages[historyMessages.length - 1];
                if (lastMessage && lastMessage.timestamp) {
                    const date = new Date(lastMessage.timestamp);
                    return this.formatDateHeader(date, this.currentLanguage);
                }
            }
            return null;
        }
        
        // ✅ ИСПРАВЛЕНИЕ: Правильно вычисляем позицию от КОНЦА
        const totalScrollableHeight = Math.max(1, scrollHeight - clientHeight);
        const scrollProgress = scrollTop / totalScrollableHeight; // 0 = вверху, 1 = внизу
        
        // Получаем только релевантные сообщения из истории
        const historyMessages = this.chatHistory.filter(msg => 
            msg.type === 'user' || msg.type === 'bot' || msg.type === 'voice'
        );
        
        // ✅ ИСПРАВЛЕНИЕ: Корректный расчет индекса
        // scrollProgress: 0 = самое старое сообщение, 1 = самое новое
        const targetIndex = Math.floor(scrollProgress * (historyMessages.length - 1));
        const clampedIndex = Math.max(0, Math.min(targetIndex, historyMessages.length - 1));

        
        const targetMessage = historyMessages[clampedIndex];
        
        if (targetMessage && targetMessage.timestamp) {
            const date = new Date(targetMessage.timestamp);
            const dateText = this.formatDateHeader(date, this.currentLanguage);
            
            return dateText;
        }
        
        return null;
        
    } catch (error) {
        this.log('error','❌ Ошибка getCurrentScrollDate:', error);
        return null;
    }
}

// Проверка нужно ли показывать заголовок даты
shouldShowDateHeader(currentTimestamp, previousTimestamp = null) {
    if (!previousTimestamp) {
        return true; // Первое сообщение - всегда показываем дату
    }
    
    try {
        const currentDate = new Date(currentTimestamp);
        const previousDate = new Date(previousTimestamp);
        
        // Сравниваем даты (игнорируя время)
        return currentDate.toDateString() !== previousDate.toDateString();
    } catch (error) {
        this.log('error','❌ Ошибка проверки заголовка даты:', error);
        return false;
    }
}

// Добавление заголовка даты в чат
addDateHeader(timestamp) {
    try {
        const date = new Date(timestamp);
        const dateText = this.formatDateHeader(date);
        
        if (!dateText) return;
        
        // Проверяем, нет ли уже такого заголовка
        const existingHeaders = this.messagesContainer.querySelectorAll('.webchat-date-header-content');
        for (let header of existingHeaders) {
            if (header.textContent === dateText) {
                return; // Не добавляем дубликат
            }
        }
        
        const headerDiv = document.createElement('div');
        headerDiv.className = 'webchat-date-header';
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'webchat-date-header-content';
        contentDiv.textContent = dateText;
        contentDiv.setAttribute('data-timestamp', timestamp);
        
        headerDiv.appendChild(contentDiv);
        this.messagesContainer.appendChild(headerDiv);
        
    } catch (error) {
        this.log('error','❌ Ошибка добавления заголовка даты:', error);
    }
}

// Добавление времени к сообщению
addTimeToMessage(messageElement, timestamp) {
    try {
        const timeText = this.formatMessageTime(timestamp);
        
        if (!timeText) return;
        
        const contentDiv = messageElement.querySelector('.webchat-message-content');
        if (!contentDiv) return;
        
        const timeDiv = document.createElement('div');
        timeDiv.className = 'webchat-message-time';
        timeDiv.textContent = timeText;
        timeDiv.setAttribute('data-timestamp', timestamp); // ✅ НОВОЕ: сохраняем timestamp
        
        contentDiv.appendChild(timeDiv);
        
    } catch (error) {
        this.log('error','❌ Ошибка добавления времени:', error);
    }
}

// Настройка обработчиков для всплывающей даты при прокрутке
// ✅ УЛУЧШЕННЫЙ setupScrollDateHandlers с динамическим обновлением даты
setupScrollDateHandlers() {
    if (!this.messagesContainer) {
        return;
    }
    
    // Создаем элемент всплывающей даты
    this.scrollDateElement = document.createElement('div');
    this.scrollDateElement.className = 'webchat-scroll-date';
    
    // Добавляем в messagesContainer
    this.messagesContainer.appendChild(this.scrollDateElement);
    // ✅ ПЕРЕМЕННЫЕ для отслеживания прокрутки и даты
    let lastScrollTop = this.messagesContainer.scrollTop;
    let scrollTimeout = null;
    let hideTimeout = null;
    let isScrolling = false;
    let currentDisplayedDate = null; // ✅ НОВОЕ: отслеживаем текущую отображаемую дату
    
    const handleScroll = () => {
        // ✅ Используем глобальное состояние для избежания проблем с замыканиями
        if (!window._webchatScrollState) {
            window._webchatScrollState = {
                lastScrollTop: 0,
                isScrolling: false,
                currentDisplayedDate: null
            };
        }
        
        const currentScrollTop = this.messagesContainer.scrollTop;
        
        // ✅ ОПРЕДЕЛЯЕМ НАПРАВЛЕНИЕ ПРОКРУТКИ
        const isScrollingUp = currentScrollTop < window._webchatScrollState.lastScrollTop;
        const scrollDelta = Math.abs(currentScrollTop - window._webchatScrollState.lastScrollTop);
        
        // ✅ ПОКАЗЫВАЕМ ТОЛЬКО ПРИ ПРОКРУТКЕ ВВЕРХ и только если прокрутили достаточно
        if (!isScrollingUp || scrollDelta < 10) {
            // Если прокручиваем вниз или очень мало - скрываем и сбрасываем состояние
            if (!isScrollingUp && window._webchatScrollState.isScrolling) {
                this.hideScrollDate();
                window._webchatScrollState.isScrolling = false;
                window._webchatScrollState.currentDisplayedDate = null; // ✅ СБРАСЫВАЕМ дату при прокрутке вниз
            }
            window._webchatScrollState.lastScrollTop = currentScrollTop;
            return;
        }
        
        // ✅ ПРОВЕРЯЕМ ЧТО НЕ В САМОМ НИЗУ
        const scrollHeight = this.messagesContainer.scrollHeight;
        const clientHeight = this.messagesContainer.clientHeight;
        const isNearBottom = currentScrollTop >= (scrollHeight - clientHeight - 50);
        
        if (isNearBottom) {
            window._webchatScrollState.lastScrollTop = currentScrollTop;
            return;
        }
     
        // ✅ ПОЛУЧАЕМ ТЕКУЩУЮ ДАТУ ДЛЯ ПРОВЕРКИ
        const currentDate = this.getCurrentScrollDate();
        
        // Отменяем предыдущий таймер скрытия
        if (hideTimeout) {
            clearTimeout(hideTimeout);
            hideTimeout = null;
        }
        
        // ✅ ПРОВЕРЯЕМ НУЖНО ЛИ ОБНОВИТЬ ДАТУ
        const dateChanged = window._webchatScrollState.currentDisplayedDate !== currentDate;
        
        if (!window._webchatScrollState.isScrolling || dateChanged) {
            // Показываем впервые или дата изменилась
            window._webchatScrollState.isScrolling = true;
            window._webchatScrollState.currentDisplayedDate = currentDate; // ✅ ЗАПОМИНАЕМ новую дату
            this.updateScrollDate();
            
            if (dateChanged) {
            }
        }
        
        // ✅ ОБНОВЛЯЕМ THROTTLING - но только позицию, не дату
        if (scrollTimeout) {
            clearTimeout(scrollTimeout);
        }
        
        scrollTimeout = setTimeout(() => {
            // Проверяем дату еще раз для подстраховки
            const latestDate = this.getCurrentScrollDate();
            if (latestDate !== window._webchatScrollState.currentDisplayedDate && window._webchatScrollState.isScrolling) {
                window._webchatScrollState.currentDisplayedDate = latestDate;
                this.updateScrollDate();
            }
            
            scrollTimeout = null;
            window._webchatScrollState.lastScrollTop = currentScrollTop;
            
        }, 200); // ✅ Частые проверки для отслеживания смены даты
        
        // ✅ АВТОСКРЫТИЕ
        if (hideTimeout) clearTimeout(hideTimeout);
        hideTimeout = setTimeout(() => {
            this.hideScrollDate();
            window._webchatScrollState.isScrolling = false;
            window._webchatScrollState.currentDisplayedDate = null; // ✅ СБРАСЫВАЕМ дату при скрытии
        }, 1500);
        
        window._webchatScrollState.lastScrollTop = currentScrollTop;
    };
    
    try {
        this.messagesContainer.addEventListener('scroll', handleScroll, { passive: true });
        
    } catch (error) {
        this.log('error','❌ Ошибка добавления обработчика scroll:', error);
    }
    
    // Сохраняем ссылку для очистки
    this.scrollHandler = handleScroll;
}

// ✅ ПОЛНОСТЬЮ ИСПРАВЛЕННЫЙ updateScrollDate
updateScrollDate() {
    if (!this.messagesContainer || !this.scrollDateElement) {
        return;
    }
    
    try {
        // ✅ НОВОЕ: Принудительно сбрасываем кэш перед получением даты
        this.lastScrollDate = null;
        
        // ✅ УПРОЩЕННЫЙ ПОДХОД: получаем дату из истории по позиции прокрутки
        const scrollTop = this.messagesContainer.scrollTop;
        const scrollHeight = this.messagesContainer.scrollHeight;
        const clientHeight = this.messagesContainer.clientHeight;
        
        // Проверяем что не в самом низу
        const isNearBottom = scrollTop >= (scrollHeight - clientHeight - 50);
        if (isNearBottom) {
            this.hideScrollDate();
            return;
        }
        
        // ✅ ИСПРАВЛЕНИЕ: Правильно вычисляем позицию в истории
        const totalScrollableHeight = scrollHeight - clientHeight;
        const currentScrollPosition = scrollTop;
        
        // Вычисляем процент прокрутки от КОНЦА (0 = внизу, 1 = вверху)
        const scrollPercentFromBottom = 1 - (currentScrollPosition / totalScrollableHeight);
        
        // Получаем сообщения из истории (только пользовательские и бот)
        const historyMessages = this.chatHistory.filter(msg => 
            msg.type === 'user' || msg.type === 'bot' || msg.type === 'voice'
        );
        
        if (historyMessages.length === 0) {
            return;
        }
        
        // ✅ ИСПРАВЛЕНИЕ: Вычисляем индекс от КОНЦА массива
        const messagesFromEnd = Math.floor(scrollPercentFromBottom * historyMessages.length);
        const targetIndex = Math.max(0, historyMessages.length - 1 - messagesFromEnd);
        const targetMessage = historyMessages[targetIndex];
        if (targetMessage && targetMessage.timestamp) {
            const date = new Date(targetMessage.timestamp);
            
            // ✅ НОВОЕ: Получаем дату с учетом текущего языка
            const dateText = this.formatDateHeader(date, this.currentLanguage);

            if (dateText) {
                // ✅ ПРИНУДИТЕЛЬНО показываем дату
                this.showScrollDate(dateText, targetMessage.timestamp);
                this.lastScrollDate = dateText;
            } else {
            }
        } else {
        }
        
    } catch (error) {
        this.log('error','❌ Ошибка updateScrollDate:', error);
    }
}

// Показать всплывающую дату
// ✅ ПЛАВНЫЙ showScrollDate без дерганий
showScrollDate(dateText, timestamp = null) {
    if (!this.scrollDateElement || !dateText) return;
    
    const currentText = this.scrollDateElement.textContent;
    const isVisible = this.scrollDateElement.classList.contains('show');

    // ✅ ПРИНУДИТЕЛЬНОЕ ОБНОВЛЕНИЕ: всегда обновляем текст и позицию
    this.scrollDateElement.textContent = dateText;
    if (timestamp) {
        this.scrollDateElement.setAttribute('data-timestamp', timestamp);
    }
    this.updateScrollDatePosition();
    
    // Показываем если не видна
    if (!isVisible) {
        this.scrollDateElement.classList.add('show');
    } else {
    }
}

// ✅ ОТДЕЛЬНЫЙ МЕТОД для обновления только позиции
updateScrollDatePosition() {
    if (!this.scrollDateElement || !this.messagesContainer) return;
    
    const containerRect = this.messagesContainer.getBoundingClientRect();
    const centerX = containerRect.left + (containerRect.width / 2);
    const topY = containerRect.top + 20;
    
    this.scrollDateElement.style.top = topY + 'px';
    this.scrollDateElement.style.left = centerX + 'px';
}

// ✅ ПОЛНЫЙ УЛУЧШЕННЫЙ hideScrollDate
hideScrollDate() {
    if (!this.scrollDateElement) {
        return;
    }
    
    // ✅ УБИРАЕМ ПРИНУДИТЕЛЬНЫЕ СТИЛИ - используем только CSS классы
    // Убираем принудительные стили opacity и visibility
    this.scrollDateElement.style.opacity = '';
    this.scrollDateElement.style.visibility = '';
    
    // ✅ ПЛАВНОЕ СКРЫТИЕ через CSS класс
    this.scrollDateElement.classList.remove('show');
    
    // ✅ НЕ удаляем элемент из DOM! Только скрываем через CSS
    
    // ✅ СБРОС СОСТОЯНИЯ после завершения CSS анимации
    setTimeout(() => {
        if (this.scrollDateElement && !this.scrollDateElement.classList.contains('show')) {
            // Сбрасываем только если элемент действительно скрыт (нет класса show)
            this.lastScrollDate = null;
            
            // ✅ НОВОЕ: Сбрасываем глобальное состояние
            if (window._webchatScrollState) {
                window._webchatScrollState.currentDisplayedDate = null;
            }
        }
    }, 300); // ✅ Увеличено до 300ms чтобы дождаться окончания CSS transition
}

// ✅ ИСПРАВЛЕННОЕ: Обновление всех времен при смене языка
updateAllMessageTimes() {
    try {
        // 1. Обновляем времена всех сообщений
        const timeElements = this.messagesContainer.querySelectorAll('.webchat-message-time');
        timeElements.forEach(timeElement => {
            const timestamp = timeElement.getAttribute('data-timestamp');
            if (timestamp) {
                const newTimeText = this.formatMessageTime(timestamp);
                timeElement.textContent = newTimeText;
            }
        });
        
        // 2. Обновляем заголовки дат
        const dateHeaders = this.messagesContainer.querySelectorAll('.webchat-date-header-content');
        dateHeaders.forEach(headerElement => {
            const timestamp = headerElement.getAttribute('data-timestamp');
            if (timestamp) {
                const newDateText = this.formatDateHeader(new Date(timestamp));
                headerElement.textContent = newDateText;
            }
        });
        
        // 3. Обновляем текст всплывающей подсказки если она показана
        if (this.scrollDateElement && this.scrollDateElement.textContent) {
            const timestamp = this.scrollDateElement.getAttribute('data-timestamp');
            if (timestamp) {
                const newDateText = this.formatDateHeader(new Date(timestamp));
                this.scrollDateElement.textContent = newDateText;
            }
        }
      
    } catch (error) {
        this.log('error','❌ Ошибка обновления времен:', error);
    }
}

// ✅ ФИНАЛЬНЫЙ forceResetDateSystem с восстановлением позиции
forceResetDateSystem() {
    //Сохраняем текущую позицию прокрутки
    const currentScrollTop = this.messagesContainer ? this.messagesContainer.scrollTop : 0;
    const scrollHeight = this.messagesContainer ? this.messagesContainer.scrollHeight : 0;
    const clientHeight = this.messagesContainer ? this.messagesContainer.clientHeight : 0;
    const isNearBottom = currentScrollTop >= (scrollHeight - clientHeight - 100);
    const wasScrolledUp = currentScrollTop > 100 && !isNearBottom;
    
    //Полностью сбрасываем все кэшированные состояния
    this.lastScrollDate = null;
    
    // 3. Удаляем старый обработчик scroll
    if (this.scrollHandler && this.messagesContainer) {
        this.messagesContainer.removeEventListener('scroll', this.scrollHandler);
        this.scrollHandler = null;
    }
    
    //Удаляем старый элемент подсказки
    if (this.scrollDateElement) {
        if (this.scrollDateElement.parentNode) {
            this.scrollDateElement.parentNode.removeChild(this.scrollDateElement);
        }
        this.scrollDateElement = null;
    }
    
    // 5. Очищаем таймауты
    if (this.scrollDateTimeout) {
        clearTimeout(this.scrollDateTimeout);
        this.scrollDateTimeout = null;
    }
    
    // 6. ✅ ВАЖНО: Очищаем глобальные переменные обработчика
    if (window._webchatScrollState) {
        delete window._webchatScrollState;
    }
    
    // 7. ✅ НЕМЕДЛЕННОЕ СИНХРОННОЕ ПЕРЕСОЗДАНИЕ
    this.setupScrollDateHandlers();
    
    // 8. ✅ НЕ ВОССТАНАВЛИВАЕМ подсказку автоматически
}

// ✅ ДОПОЛНИТЕЛЬНЫЙ метод для принудительного обновления подсказки
forceShowCurrentDate() {
    if (!this.messagesContainer || !this.scrollDateElement) {
        return;
    }
    
    // Проверяем что пользователь прокрутил вверх
    const scrollTop = this.messagesContainer.scrollTop;
    const scrollHeight = this.messagesContainer.scrollHeight;
    const clientHeight = this.messagesContainer.clientHeight;
    const isNearBottom = scrollTop >= (scrollHeight - clientHeight - 50);
    
    if (!isNearBottom) {
        const currentDate = this.getCurrentScrollDate();
        if (currentDate) {
            this.showScrollDate(currentDate);
        }
    }
}

// ✅ УЛУЧШЕННЫЙ setupScrollDateHandlers с проверками
setupScrollDateHandlers() {
    if (!this.messagesContainer) {
        return;
    }
    
    // Убеждаемся что старый элемент удален
    const existingScrollDate = this.messagesContainer.querySelector('.webchat-scroll-date');
    if (existingScrollDate) {
        existingScrollDate.remove();
    }
    
    // Создаем новый элемент всплывающей даты
    this.scrollDateElement = document.createElement('div');
    this.scrollDateElement.className = 'webchat-scroll-date';
    
    // Добавляем в messagesContainer
    this.messagesContainer.appendChild(this.scrollDateElement);
    // ✅ ПЕРЕМЕННЫЕ для отслеживания прокрутки и даты
    let lastScrollTop = this.messagesContainer.scrollTop;
    let scrollTimeout = null;
    let hideTimeout = null;
    let isScrolling = false;
    let currentDisplayedDate = null; // ✅ НОВОЕ: отслеживаем текущую отображаемую дату
    
    // ✅ ВАЖНО: Сбрасываем глобальное состояние при создании нового обработчика
    window._webchatScrollState = {
        lastScrollTop: lastScrollTop,
        isScrolling: false,
        currentDisplayedDate: null
    };
    
    const handleScroll = () => {
        const currentScrollTop = this.messagesContainer.scrollTop;
        
        // Определяем направление прокрутки
        const isScrollingUp = currentScrollTop < lastScrollTop;
        const scrollDelta = Math.abs(currentScrollTop - lastScrollTop);
        
        // Показываем только при прокрутке вверх и достаточном движении
        if (!isScrollingUp || scrollDelta < 10) {
            if (!isScrollingUp && isScrolling) {
                this.hideScrollDate();
                isScrolling = false;
                currentDisplayedDate = null;
            }
            lastScrollTop = currentScrollTop;
            return;
        }
        
        // Проверяем что не в самом низу
        const scrollHeight = this.messagesContainer.scrollHeight;
        const clientHeight = this.messagesContainer.clientHeight;
        const isNearBottom = currentScrollTop >= (scrollHeight - clientHeight - 50);
        
        if (isNearBottom) {
            lastScrollTop = currentScrollTop;
            return;
        }
        // Отменяем предыдущий таймер скрытия
        if (hideTimeout) {
            clearTimeout(hideTimeout);
            hideTimeout = null;
        }
        
        // ✅ НЕМЕДЛЕННО получаем и показываем дату (без throttling!)
        const currentDate = this.getCurrentScrollDate();
        
        if (currentDate && currentDate !== currentDisplayedDate) {
            isScrolling = true;
            currentDisplayedDate = currentDate;
            this.showScrollDate(currentDate);
        } else if (!isScrolling && currentDate) {
            isScrolling = true;
            currentDisplayedDate = currentDate;
            this.showScrollDate(currentDate);
        }
        
        // Автоскрытие
        if (hideTimeout) clearTimeout(hideTimeout);
        hideTimeout = setTimeout(() => {
            this.hideScrollDate();
            isScrolling = false;
            currentDisplayedDate = null;
        }, 1500);
        
        lastScrollTop = currentScrollTop;
    };
    
    try {
        this.messagesContainer.addEventListener('scroll', handleScroll, { passive: true });
        // Сохраняем ссылку для очистки
        this.scrollHandler = handleScroll;
        
    } catch (error) {
        this.log('error','❌ Ошибка добавления обработчика scroll:', error);
    }
}

// ✅ НОВЫЙ МЕТОД: Очистка обработчиков времени при уничтожении
cleanupScrollDateHandlers() {
    if (this.scrollHandler && this.messagesContainer) {
        this.messagesContainer.removeEventListener('scroll', this.scrollHandler);
        this.scrollHandler = null;
    }
    
    if (this.scrollDateElement && this.scrollDateElement.parentNode) {
        this.scrollDateElement.parentNode.removeChild(this.scrollDateElement);
        this.scrollDateElement = null;
    }
    
    if (this.scrollDateTimeout) {
        clearTimeout(this.scrollDateTimeout);
        this.scrollDateTimeout = null;
    }

}
    
    // Форматирование размера файла
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
    
    // Очистка выбранного файла
    clearFile() {
        this.currentFile = null;

        // ✅ ИСПРАВЛЕНИЕ УТЕЧКИ ПАМЯТИ: Освобождаем URL preview изображения
        if (this.currentPreviewImageUrl) {
            URL.revokeObjectURL(this.currentPreviewImageUrl);
            this.currentPreviewImageUrl = null;
        }

        if (this.filePreview) {
            this.filePreview.classList.remove('show');
        }
        if (this.fileInput) {
            this.fileInput.value = '';
        }

        this.log('debug', '🗑️ Файл очищен');
    }
    
    // Показ индикатора загрузки файла
    showFileUploading() {
        if (this.fileUploadingIndicator) {
            this.fileUploadingIndicator.classList.add('show');
        }
    }
    
    // Скрытие индикатора загрузки файла
    hideFileUploading() {
        if (this.fileUploadingIndicator) {
            this.fileUploadingIndicator.classList.remove('show');
        }
    }
    // Конвертация файла в base64
    fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = () => {
                try {
                   const base64Data = reader.result.split(',')[1]; // Убираем префикс data:...;base64,
                    
                    const result = {
                        data: base64Data,
                        name: file.name,
                        type: file.type,
                        size: file.size,
                        format: 'base64'
                    };

                    resolve(result);
                } catch (error) {
                    this.log('error','❌ Ошибка в fileToBase64.onload:', error);
                    reject(error);
                }
            };
            
            reader.onerror = () => {
                this.log('error','❌ FileReader.onerror:', reader.error);
                reject(new Error('Ошибка чтения файла'));
            };
            reader.readAsDataURL(file);
        });
    }
    
    // Добавление сообщения с файлом
    async addFileMessage(messageText, file, type) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `webchat-message webchat-${type}`;

        const avatar = document.createElement('div');
        avatar.className = `webchat-message-avatar webchat-${type}-avatar`;
        avatar.textContent = type === 'bot' ? this.config.botInfo.avatar : (this.config.userInfo && this.config.userInfo.avatar ? this.config.userInfo.avatar : '👤');

        const contentDiv = document.createElement('div');
        contentDiv.className = 'webchat-message-content';

        // Текст сообщения если есть
        if (messageText) {
            const textDiv = document.createElement('div');
            textDiv.innerHTML = this.sanitizeHTML(messageText); // ✅ БЕЗОПАСНОСТЬ: Санитизация HTML
            contentDiv.appendChild(textDiv);
        }

        // ✅ ИСПРАВЛЕНИЕ: Конвертируем файл в base64 для сохранения
        let fileBase64 = null;
        try {
            const reader = new FileReader();
            fileBase64 = await new Promise((resolve, reject) => {
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        } catch (error) {
            this.log('error', '❌ Ошибка конвертации файла в base64:', error);
        }

        // Файл
        if (file.type.startsWith('image/')) {
            // Для изображений показываем превью
            const img = document.createElement('img');
            // ✅ ИСПРАВЛЕНИЕ: Проверяем что src это строка, а не объект
            const imgSrc = fileBase64 || URL.createObjectURL(file);
            img.src = typeof imgSrc === 'string' ? imgSrc : '';
            img.className = 'webchat-message-image';
            img.alt = file.name;

            contentDiv.appendChild(img);
        } else {
            // Для других файлов показываем иконку и информацию
            const fileContainer = document.createElement('div');
            fileContainer.className = 'webchat-message-file';

            const fileIcon = document.createElement('div');
            fileIcon.className = 'webchat-message-file-icon';
            fileIcon.textContent = this.getFileIcon(file.type);

            const fileInfo = document.createElement('div');
            fileInfo.className = 'webchat-message-file-info';

            const fileName = document.createElement('div');
            fileName.className = 'webchat-message-file-name';
            fileName.textContent = file.name;

            const fileSize = document.createElement('div');
            fileSize.className = 'webchat-message-file-size';
            fileSize.textContent = this.formatFileSize(file.size);

            fileInfo.appendChild(fileName);
            fileInfo.appendChild(fileSize);
            fileContainer.appendChild(fileIcon);
            fileContainer.appendChild(fileInfo);

            contentDiv.appendChild(fileContainer);
        }

        messageDiv.appendChild(avatar);
        messageDiv.appendChild(contentDiv);
        this.messagesContainer.appendChild(messageDiv);

        this.scrollToBottom();

        // ✅ ИСПРАВЛЕНИЕ: Сохраняем в истории с base64 данными
        this.chatHistory.push({
            type: type,
            content: messageText,
            file: {
                name: file.name,
                type: file.type,
                size: file.size,
                data: fileBase64 // ✅ Сохраняем base64 данные
            },
            timestamp: new Date().toISOString(),
            config: this.currentConfigName
        });
    }

    // ✅ НОВЫЙ МЕТОД: Добавление сообщения с файлом из истории (БЕЗ повторного сохранения)
    addFileMessageFromHistory(messageText, fileData, type, timestamp) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `webchat-message webchat-${type}`;

        const avatar = document.createElement('div');
        avatar.className = `webchat-message-avatar webchat-${type}-avatar`;
        avatar.textContent = type === 'bot' ? this.config.botInfo.avatar : (this.config.userInfo && this.config.userInfo.avatar ? this.config.userInfo.avatar : '👤');

        const contentDiv = document.createElement('div');
        contentDiv.className = 'webchat-message-content';

        // Текст сообщения если есть
        if (messageText) {
            const textDiv = document.createElement('div');
            textDiv.innerHTML = this.sanitizeHTML(messageText);
            contentDiv.appendChild(textDiv);
        }

        // Файл
        if (fileData.type.startsWith('image/')) {
            // Для изображений показываем превью
            const img = document.createElement('img');
            // ✅ ИСПРАВЛЕНИЕ: Проверяем что data это строка, а не объект
            img.src = (fileData.data && typeof fileData.data === 'string') ? fileData.data : '';
            img.className = 'webchat-message-image';
            img.alt = fileData.name;

            contentDiv.appendChild(img);
        } else {
            // Для других файлов показываем иконку и информацию
            const fileContainer = document.createElement('div');
            fileContainer.className = 'webchat-message-file';

            const fileIcon = document.createElement('div');
            fileIcon.className = 'webchat-message-file-icon';
            fileIcon.textContent = this.getFileIcon(fileData.type);

            const fileInfo = document.createElement('div');
            fileInfo.className = 'webchat-message-file-info';

            const fileName = document.createElement('div');
            fileName.className = 'webchat-message-file-name';
            fileName.textContent = fileData.name;

            const fileSize = document.createElement('div');
            fileSize.className = 'webchat-message-file-size';
            fileSize.textContent = this.formatFileSize(fileData.size);

            fileInfo.appendChild(fileName);
            fileInfo.appendChild(fileSize);
            fileContainer.appendChild(fileIcon);
            fileContainer.appendChild(fileInfo);

            contentDiv.appendChild(fileContainer);
        }

        messageDiv.appendChild(avatar);
        messageDiv.appendChild(contentDiv);
        this.messagesContainer.appendChild(messageDiv);

        // ✅ Добавляем время к восстановленному сообщению
        if (timestamp) {
            this.addTimeToMessage(messageDiv, timestamp);
        }

        this.scrollToBottom();
    }

    // ===============================================
    // ✅ ВИДЕОСООБЩЕНИЯ В КРУЖКЕ
    // ===============================================
    
    // Добавление видеосообщения от AI
    addVideoMessage(videoData, text) {
    const timestamp = new Date().toISOString();
    
    // Проверяем нужно ли добавить заголовок даты
    const lastMessage = this.chatHistory[this.chatHistory.length - 1];
    if (this.shouldShowDateHeader(timestamp, lastMessage?.timestamp)) {
        this.addDateHeader(timestamp);
    }
    
    const messageDiv = document.createElement('div');
    messageDiv.className = 'webchat-message webchat-bot webchat-video-message';
    
    const avatar = document.createElement('div');
    avatar.className = 'webchat-message-avatar webchat-bot-avatar';
    avatar.textContent = this.config.botInfo.avatar;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'webchat-message-content';
    
    // ✅ УБИРАЕМ СЕРУЮ ПОДЛОЖКУ У ВИДЕО
    contentDiv.style.background = 'transparent';
    contentDiv.style.border = 'none';
    contentDiv.style.padding = '0';
    contentDiv.style.boxShadow = 'none';
    
    // Текст сообщения (ТОЛЬКО реальный текст от AI, не пустые строки)
if (text && text.trim().length > 0) {
    const textDiv = document.createElement('div');
    textDiv.style.marginBottom = '10px';
    textDiv.innerHTML = this.sanitizeHTML(text); // ✅ БЕЗОПАСНОСТЬ: Санитизация HTML
    contentDiv.appendChild(textDiv);
}
    
    // Создаем видео-плеер
    const videoContainer = this.createVideoPlayer(videoData);
    contentDiv.appendChild(videoContainer);
    
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    
    // Добавляем время
    this.addTimeToMessage(messageDiv, timestamp);
    
    this.messagesContainer.appendChild(messageDiv);
    this.scrollToBottom();
    
    // Сохраняем в истории
    this.chatHistory.push({
    type: 'video',
    content: text || this.texts.system?.videoMessage || '🎥 Video message',
    videoUrl: videoData.url,
        videoDuration: videoData.duration,
        thumbnail: videoData.thumbnail,
        timestamp: timestamp,
        config: this.currentConfigName
    });
    
    this.saveChatHistory();
}

// ✅ НОВЫЙ МЕТОД: Добавление видеосообщения из истории (БЕЗ повторного сохранения)
async addVideoMessageFromHistory(videoData, text) {
    this.log('debug', '🎥 Восстанавливаем видеосообщение из истории:', {
        url: videoData.url,
        duration: videoData.duration,
        hasThumbnail: !!videoData.thumbnail
    });
    
    // Создаем UI элемент (аналогично addVideoMessage, но без сохранения в историю)
    const messageDiv = document.createElement('div');
    messageDiv.className = 'webchat-message webchat-bot webchat-video-message';
    
    const avatar = document.createElement('div');
    avatar.className = 'webchat-message-avatar webchat-bot-avatar';
    avatar.textContent = this.config.botInfo.avatar;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'webchat-message-content';
    
    // ✅ УБИРАЕМ СЕРУЮ ПОДЛОЖКУ У ВИДЕО
    contentDiv.style.background = 'transparent';
    contentDiv.style.border = 'none';
    contentDiv.style.padding = '0';
    contentDiv.style.boxShadow = 'none';
    
   // Текст сообщения (ТОЛЬКО реальный текст от AI, не пустые строки)
if (text && text.trim().length > 0) {
    const textDiv = document.createElement('div');
    textDiv.style.marginBottom = '10px';
    textDiv.innerHTML = this.sanitizeHTML(text); // ✅ БЕЗОПАСНОСТЬ: Санитизация HTML
    contentDiv.appendChild(textDiv);
}
    
    // Создаем видео-плеер (переиспользуем существующий метод)
    const videoContainer = this.createVideoPlayer(videoData);
    contentDiv.appendChild(videoContainer);
    
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    this.messagesContainer.appendChild(messageDiv);
    
    this.log('info', '✅ Видеосообщение успешно восстановлено в UI');
}
    
    // Создание круглого видеоплеера
createVideoPlayer(videoData) {
    const container = document.createElement('div');
    container.className = 'webchat-video-message';
    
    const circle = document.createElement('div');
    circle.className = 'webchat-video-circle';
    
    // Видео элемент
const video = document.createElement('video');
// ✅ ИСПРАВЛЕНИЕ: Проверяем что url это строка, а не объект
video.src = typeof videoData.url === 'string' ? videoData.url : '';
video.preload = 'metadata';
video.loop = false;
video.controls = false;

// ✅ КРИТИЧНО ДЛЯ МОБИЛЬНЫХ - воспроизведение в кружке
video.setAttribute('playsinline', '');
video.setAttribute('webkit-playsinline', '');
video.setAttribute('x5-playsinline', '');
video.playsInline = true;

// Thumbnail (если есть)
// ✅ ИСПРАВЛЕНИЕ: Проверяем что thumbnail это строка, а не объект
if (videoData.thumbnail && typeof videoData.thumbnail === 'string') {
    video.poster = videoData.thumbnail;
}
  // ✅ НОВЫЙ ОБРАБОТЧИК: Показываем ошибку если видео не загружается
video.addEventListener('error', () => {
    this.log('error', '❌ Ошибка загрузки видео:', videoData.url);
    
    // Заменяем содержимое круга на сообщение об ошибке
    const errorMessage = this.texts.system?.videoMessageUnavailable || '🎥 Video unavailable';
    
    // Очищаем круг и показываем ошибку
    circle.innerHTML = `
        <div style="
            display: flex; 
            flex-direction: column;
            align-items: center; 
            justify-content: center; 
            height: 100%; 
            width: 100%;
            color: #ff6b6b; 
            font-size: 14px; 
            text-align: center; 
            padding: 20px;
            box-sizing: border-box;
        ">
            <div style="font-size: 40px; margin-bottom: 10px;">⚠️</div>
            <div>${errorMessage}</div>
        </div>
    `;
});
    
    // Кнопка Play
    const playBtn = document.createElement('button');
    playBtn.className = 'webchat-video-play-btn';
    playBtn.innerHTML = `
        <span class="play-icon">▶</span>
        <span class="pause-icon">⏸</span>
    `;
    
    // ✅ Круговой прогресс (как в Telegram)
const circleProgressContainer = document.createElement('div');
circleProgressContainer.className = 'webchat-video-circle-progress';
const radius = 123;
const circumference = 2 * Math.PI * radius;
const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
svg.setAttribute('viewBox', '0 0 250 250');
svg.setAttribute('width', '250');
svg.setAttribute('height', '250');
const circleProgress = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
circleProgress.setAttribute('cx', '125');
circleProgress.setAttribute('cy', '125');
circleProgress.setAttribute('r', radius);
circleProgress.style.strokeDasharray = circumference;
circleProgress.style.strokeDashoffset = circumference;
svg.appendChild(circleProgress);
circleProgressContainer.appendChild(svg);

// Линейный прогресс бар (оставляем для совместимости)
const progressContainer = document.createElement('div');
progressContainer.className = 'webchat-video-progress';
const progressBar = document.createElement('div');
progressBar.className = 'webchat-video-progress-bar';
progressContainer.appendChild(progressBar);

// Собираем плеер (БЕЗ infoDiv)
circle.appendChild(video);
circle.appendChild(circleProgressContainer);
circle.appendChild(playBtn);
circle.appendChild(progressContainer);

container.appendChild(circle);
// ← infoDiv удален

// Логика воспроизведения
this.setupVideoPlayerLogic(video, playBtn, progressBar, circle, circleProgress, circumference);

return container;
}
    
    // Логика управления видео
setupVideoPlayerLogic(video, playBtn, progressBar, circle, circleProgress, circumference) {
    let isPlaying = false;
    let progressInterval = null;
    
    // ✅ Очистка ресурсов при удалении элемента
    const cleanup = () => {
        if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
        }
        
        // Освобождаем URL объект
        if (video.src && video.src.startsWith('blob:')) {
            URL.revokeObjectURL(video.src);
        }
    };
    
    // ✅ Отслеживаем удаление элемента из DOM
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.removedNodes.forEach((node) => {
                if (node === circle || node.contains(circle)) {
                    cleanup();
                    observer.disconnect();
                }
            });
        });
    });
    
    // Наблюдаем за родительским контейнером
    if (circle.parentNode) {
        observer.observe(circle.parentNode, { childList: true, subtree: true });
    }
    
    // Обработчик клика
    const togglePlay = () => {
        if (isPlaying) {
            // Пауза
            video.pause();
            playBtn.classList.remove('playing');
            isPlaying = false;
            
            if (progressInterval) {
                clearInterval(progressInterval);
                progressInterval = null;
            }
        } else {
            // Воспроизведение
            video.play().then(() => {
                playBtn.classList.add('playing');
                isPlaying = true;
                
                // Обновляем прогресс
                progressInterval = setInterval(() => {
                    if (video.duration) {
                        const progress = (video.currentTime / video.duration) * 100;
                        progressBar.style.width = progress + '%';
                        
                        // Обновляем круговой прогресс
                        const offset = circumference - (progress / 100) * circumference;
                        circleProgress.style.strokeDashoffset = offset;
                    }
                }, 100);
                
            }).catch(error => {
                this.log('error', '❌ Ошибка воспроизведения видео:', error);
                playBtn.classList.remove('playing');
                isPlaying = false;
            });
        }
    };
    
    // Клик на кнопку Play
    playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePlay();
    });
    
    // Клик на весь кружок
    circle.addEventListener('click', togglePlay);
    
    // Окончание видео
    video.addEventListener('ended', () => {
        playBtn.classList.remove('playing');
        isPlaying = false;
        progressBar.style.width = '0%';
        circleProgress.style.strokeDashoffset = circumference;
        
        if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
        }
        
        video.currentTime = 0;
    });
    
    // ✅ Очистка при выгрузке страницы
    window.addEventListener('beforeunload', cleanup);
}
    
    // Форматирование длительности видео
    formatDuration(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
    
    // ✅ НОВЫЙ МЕТОД: Переинициализация обработчиков файлов
    reinitializeFileHandlers() {
        this.log('debug', '🔄 Переинициализация обработчиков файлов...');
        
        // Обновляем ссылки на DOM элементы
        this.fileInput = document.getElementById('webchatFileInput');
        this.filePreview = document.getElementById('webchatFilePreview');
        this.fileUploadingIndicator = document.getElementById('webchatFileUploading');
        
        // Обновляем настройки файлов из новой конфигурации
        this.fileSettings = {
            maxFileSize: this.config.technical?.maxFileSize || 10 * 1024 * 1024,
            allowedTypes: this.config.technical?.allowedFileTypes || [
                'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
                'application/pdf', 'text/plain', 'text/csv',
                'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            ],
            enablePasteImages: this.config.behavior?.enablePasteImages !== false,
            enableFileUpload: this.config.behavior?.enableFileUpload !== false
        };
        
        // Очищаем текущий файл если есть
        this.clearFile();
        
        // Переинициализируем обработчики
        this.setupFileHandlers();
        
        // Обновляем видимость кнопки файлов
        const fileBtn = document.getElementById('webchatFileBtn');
        if (fileBtn) {
            if (this.fileSettings.enableFileUpload) {
                fileBtn.style.display = 'flex';
                fileBtn.title = this.texts.interface.fileTooltip || 'Прикрепить файл';
            } else {
                fileBtn.style.display = 'none';
            }
        }
        
        // Обновляем атрибут accept у input файла
        if (this.fileInput) {
            const allowedExtensions = this.getAcceptAttribute();
            this.fileInput.setAttribute('accept', allowedExtensions);
        }
        
        this.log('info', '✅ Обработчики файлов переинициализированы', {
            enableFileUpload: this.fileSettings.enableFileUpload,
            enablePasteImages: this.fileSettings.enablePasteImages,
            maxFileSize: this.formatFileSize(this.fileSettings.maxFileSize)
        });
    }
    
    // Получение атрибута accept для input файла
    getAcceptAttribute() {
        const typeToExtension = {
            'image/jpeg': '.jpg,.jpeg',
            'image/png': '.png',
            'image/gif': '.gif',
            'image/webp': '.webp',
            'image/bmp': '.bmp',
            'application/pdf': '.pdf',
            'text/plain': '.txt',
            'text/csv': '.csv',
            'application/msword': '.doc',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
            'application/vnd.ms-excel': '.xls',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx'
        };
        
        const extensions = this.fileSettings.allowedTypes
            .map(type => typeToExtension[type] || '')
            .filter(ext => ext !== '')
            .join(',');
            
        return extensions || 'image/*,application/pdf,.doc,.docx,.txt,.csv,.xls,.xlsx';
    }
}



// ==============================================
// ГЛОБАЛЬНАЯ ИНИЦИАЛИЗАЦИЯ
// ==============================================

// ✅ ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ: Изменение яркости цвета
function adjustColor(color, amount) {
    // Простая функция для затемнения/осветления цвета
    const num = parseInt(color.replace('#', ''), 16);
    const r = Math.max(0, Math.min(255, (num >> 16) + amount));
    const g = Math.max(0, Math.min(255, ((num >> 8) & 0x00FF) + amount));
    const b = Math.max(0, Math.min(255, (num & 0x0000FF) + amount));
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

// Глобальная переменная для доступа к чату
let webChat = null;

// Функция инициализации
function initWebChat(config = {}) {
    if (webChat) {
        this.log('warn','⚠️ Web chat already initialized');
        return webChat;
    }
    
    webChat = new SimpleWebChat(config);
    
    // Добавляем в глобальный объект для доступа из HTML
    window.webChat = webChat;

    return webChat;
}

// Автоинициализация при загрузке DOM
document.addEventListener('DOMContentLoaded', function() {
    // ✅ ШАГ 1: Устанавливаем WebChatConfig если его еще нет
    if (!window.WebChatConfig) {
        console.log('🔧 Автоматическая установка WebChatConfig...');
        
        // Проверяем выбранную конфигурацию
        if (window.webchatSelectedConfig && window[window.webchatSelectedConfig]) {
            window.WebChatConfig = window[window.webchatSelectedConfig];
            console.log('✅ Установлена выбранная конфигурация:', window.webchatSelectedConfig);
        }
        // Пытаемся использовать дефолтную конфигурацию
        else if (typeof window.getDefaultConfig === 'function') {
            window.WebChatConfig = window.getDefaultConfig();
            console.log('✅ Использована конфигурация по умолчанию');
        }
        // Fallback на financeConfig
        else if (window.financeConfig) {
            window.WebChatConfig = window.financeConfig;
            console.log('✅ Использована financeConfig как fallback');
        }
        else {
            console.error('❌ Не найдена ни одна конфигурация!');
        }
    }
    
    // ✅ ШАГ 2: Проверяем и инициализируем чат
    if (!webChat && window.WebChatConfig) {
        setTimeout(() => {
            initWebChat();
        }, 500);
    } else if (!window.WebChatConfig) {
        console.error('❌ WebChatConfig не установлен! Чат не может быть инициализирован.');
        console.log('💡 Убедитесь что webchat-config.js загружен и содержит конфигурации.');
    }
});

// Экспорт для использования в модулях
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SimpleWebChat, initWebChat };
}

// ✅ ДОПОЛНИТЕЛЬНЫЕ ГЛОБАЛЬНЫЕ ФУНКЦИИ ДЛЯ СОВМЕСТИМОСТИ
window.SimpleWebChat = SimpleWebChat;
window.initWebChat = initWebChat;
// ✅ НОВЫЕ ГЛОБАЛЬНЫЕ ФУНКЦИИ ДЛЯ УПРАВЛЕНИЯ ЯЗЫКАМИ
window.WebChatLanguageAPI = {
    // Переключить язык чата
    setLanguage: function(language) {
        if (window.webChat && window.webChat.setLanguage) {
            return window.webChat.setLanguage(language);
        }
        return false;
    },
    
    // Получить текущий язык
    getCurrentLanguage: function() {
        if (window.webChat && window.webChat.getCurrentLanguage) {
            return window.webChat.getCurrentLanguage();
        }
        return null;
    },
    
    // Получить информацию о языках
    getLanguageInfo: function() {
        if (window.webChat && window.webChat.getLanguageInfo) {
            return window.webChat.getLanguageInfo();
        }
        return null;
    },
    
    // Включить/отключить переключатель языков
    setLanguageSwitcherEnabled: function(enabled) {
        if (window.webChat && window.webChat.setLanguageSwitcherEnabled) {
            window.webChat.setLanguageSwitcherEnabled(enabled);
            return true;
        }
        return false;
    }
};
