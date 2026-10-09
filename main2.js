const slideshows = {
    coffee: { index: 0, container: document.getElementById('coffee-slideshow') },
    dessert: { index: 0, container: document.getElementById('dessert-slideshow') }
};

function showSlides(type) {
    const slideshow = slideshows[type];
    const slides = slideshow.container.getElementsByClassName('slide');
    const total = slides.length;

    for (let i = 0; i < total; i++) {
        slides[i].style.transform = `translateX(-${slideshow.index * 100}%)`;
    }
}

function plusSlides(type, n) {
    const slideshow = slideshows[type];
    const slides = slideshow.container.getElementsByClassName('slide');
    const total = slides.length;
    const visible = 4; // number of slides visible at a time

    slideshow.index += n;

    // Wrap around
    if (slideshow.index < 0) slideshow.index = total - visible;
    if (slideshow.index > total - visible ) slideshow.index = 0;

    showSlides(type);
}


// Initialize
showSlides('coffee');
showSlides('dessert');
